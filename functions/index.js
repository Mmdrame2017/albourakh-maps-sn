<artifact identifier="index-js-perfect-sync" type="application/vnd.ant.code" language="javascript" title="index.js - Cloud Functions Al Bourakh (Synchronisation Parfaite)">
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();
// ==========================================
// CONFIGURATION SYSTÈME
// ==========================================
async function getSystemParams() {
try {
const doc = await db.collection('parametres').doc('config').get();
if (doc.exists) {
return doc.data();
}
return {
assignationAutomatique: true,
delaiReassignation: 10,
rayonRecherche: 10,
notificationsActives: true
};
} catch (error) {
console.error('Erreur récupération paramètres:', error);
return {
assignationAutomatique: true,
delaiReassignation: 10,
rayonRecherche: 10,
notificationsActives: true
};
}
}
// ==========================================
// 1. ASSIGNATION AUTOMATIQUE
// ==========================================
exports.assignerChauffeurAutomatique = functions.firestore
.document('reservations/{reservationId}')
.onCreate(async (snap, context) => {
const reservation = snap.data();
const reservationId = context.params.reservationId;
console.log(`🚕 Nouvelle réservation détectée: ${reservationId}`);

if (reservation.statut !== 'en_attente') {
  console.log('⚠️ Réservation déjà traitée');
  return null;
}

const params = await getSystemParams();

if (!params.assignationAutomatique) {
  console.log('🔴 MODE MANUEL activé - Pas d\'assignation automatique');
  
  await db.collection('notifications_admin').add({
    type: 'nouvelle_reservation_manuelle',
    reservationId: reservationId,
    message: `Nouvelle réservation en attente - Mode manuel activé`,
    clientNom: reservation.clientNom,
    depart: reservation.depart,
    destination: reservation.destination,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    lu: false
  });
  
  return null;
}

console.log('🟢 MODE AUTO activé - Assignation automatique en cours...');

try {
  const chauffeursSnapshot = await db.collection('drivers')
    .where('statut', '==', 'disponible')
    .get();
  
  if (chauffeursSnapshot.empty) {
    console.log('❌ Aucun chauffeur disponible');
    
    await db.collection('notifications_admin').add({
      type: 'aucun_chauffeur',
      reservationId: reservationId,
      message: `Aucun chauffeur disponible - Assignation manuelle requise`,
      clientNom: reservation.clientNom,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      lu: false
    });
    
    return null;
  }
  
  let departCoords = null;
  if (reservation.departCoords) {
    departCoords = reservation.departCoords;
  } else {
    departCoords = getDefaultCoordsForAddress(reservation.depart);
  }
  
  const chauffeurs = [];
  
  chauffeursSnapshot.forEach(doc => {
    const chauffeur = doc.data();
    
    if (!chauffeur.position || !chauffeur.position.latitude) {
      console.log(`⚠️ Chauffeur ${doc.id} sans position GPS`);
      return;
    }
    
    // ✅ CORRECTION: Vérifier qu'il n'a pas déjà de course
    if (chauffeur.reservationEnCours || chauffeur.currentBookingId) {
      console.log(`⚠️ Chauffeur ${doc.id} a déjà une course (reservationEnCours: ${chauffeur.reservationEnCours}, currentBookingId: ${chauffeur.currentBookingId})`);
      return;
    }
    
    const distance = calculerDistance(
      departCoords.lat,
      departCoords.lng,
      chauffeur.position.latitude,
      chauffeur.position.longitude
    );
    
    console.log(`📍 ${chauffeur.prenom} ${chauffeur.nom}: ${distance.toFixed(2)} km`);
    
    if (distance <= params.rayonRecherche) {
      chauffeurs.push({
        id: doc.id,
        ...chauffeur,
        distance: distance
      });
    }
  });
  
  if (chauffeurs.length === 0) {
    console.log(`❌ Aucun chauffeur disponible dans ${params.rayonRecherche} km`);
    
    await db.collection('notifications_admin').add({
      type: 'aucun_chauffeur_proximite',
      reservationId: reservationId,
      message: `Aucun chauffeur trouvé dans un rayon de ${params.rayonRecherche} km`,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      lu: false
    });
    
    return null;
  }
  
  chauffeurs.sort((a, b) => a.distance - b.distance);
  const chauffeurChoisi = chauffeurs[0];
  
  console.log(`✅ Chauffeur sélectionné: ${chauffeurChoisi.prenom} ${chauffeurChoisi.nom} (${chauffeurChoisi.distance.toFixed(2)} km)`);
  
  await snap.ref.update({
    chauffeurAssigne: chauffeurChoisi.id,
    nomChauffeur: `${chauffeurChoisi.prenom} ${chauffeurChoisi.nom}`,
    telephoneChauffeur: chauffeurChoisi.telephone,
    statut: 'assignee',
    dateAssignation: admin.firestore.FieldValue.serverTimestamp(),
    distanceChauffeur: Math.round(chauffeurChoisi.distance * 1000),
    tempsArriveeChauffeur: Math.round(chauffeurChoisi.distance * 3),
    modeAssignation: 'automatique'
  });
  
  // ✅✅✅ SYNCHRONISATION AUTOMATIQUE ✅✅✅
  console.log('🔄 SYNCHRONISATION: Mise à jour chauffeur avec currentBookingId + reservationEnCours');
  
  await db.collection('drivers').doc(chauffeurChoisi.id).update({
    statut: 'en_course',
    currentBookingId: reservationId,       // ← Pour l'app chauffeur
    reservationEnCours: reservationId,     // ← Pour les Cloud Functions
    derniereAssignation: admin.firestore.FieldValue.serverTimestamp()
  });
  
  console.log('✅ SYNCHRONISATION RÉUSSIE!');
  
  await db.collection('notifications').add({
    destinataire: chauffeurChoisi.telephone,
    chauffeurId: chauffeurChoisi.id,
    type: 'nouvelle_course',
    reservationId: reservationId,
    depart: reservation.depart,
    destination: reservation.destination,
    clientNom: reservation.clientNom,
    clientTelephone: reservation.clientTelephone,
    prixEstime: reservation.prixEstime,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    lu: false
  });
  
  await db.collection('notifications_admin').add({
    type: 'assignation_reussie',
    reservationId: reservationId,
    message: `✅ ${chauffeurChoisi.prenom} ${chauffeurChoisi.nom} assigné automatiquement (${chauffeurChoisi.distance.toFixed(1)} km)`,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    lu: false
  });
  
  console.log('✅ Assignation automatique réussie!');
  return null;
  
} catch (error) {
  console.error('❌ Erreur assignation:', error);
  
  await db.collection('erreurs_systeme').add({
    type: 'erreur_assignation_auto',
    reservationId: reservationId,
    message: error.message,
    stack: error.stack,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });
  
  return null;
}
});
// ==========================================
// 2. ASSIGNATION MANUELLE
// ==========================================
exports.assignerChauffeurManuel = functions.https.onCall(async (data, context) => {
if (!context.auth) {
throw new functions.https.HttpsError('unauthenticated', 'Utilisateur non authentifié');
}
const { reservationId, chauffeurId } = data;
if (!reservationId || !chauffeurId) {
throw new functions.https.HttpsError('invalid-argument', 'reservationId et chauffeurId requis');
}
try {
const reservationDoc = await db.collection('reservations').doc(reservationId).get();
if (!reservationDoc.exists) {
throw new functions.https.HttpsError('not-found', 'Réservation non trouvée');
}
const reservation = reservationDoc.data();

// ✅ CORRECTION: Si un chauffeur était déjà assigné, libérer COMPLÈTEMENT
if (reservation.chauffeurAssigne) {
  console.log('🔄 Libération de l\'ancien chauffeur:', reservation.chauffeurAssigne);
  
  await db.collection('drivers').doc(reservation.chauffeurAssigne).update({
    statut: 'disponible',
    currentBookingId: null,         // ← Synchronisé
    reservationEnCours: null        // ← Synchronisé
  });
}

const chauffeurDoc = await db.collection('drivers').doc(chauffeurId).get();
if (!chauffeurDoc.exists) {
  throw new functions.https.HttpsError('not-found', 'Chauffeur non trouvé');
}

const chauffeur = chauffeurDoc.data();

// ✅ CORRECTION: Vérifier que le nouveau chauffeur n'a pas déjà de course
if (chauffeur.reservationEnCours || chauffeur.currentBookingId) {
  throw new functions.https.HttpsError(
    'failed-precondition', 
    `Le chauffeur a déjà une course en cours (ID: ${chauffeur.reservationEnCours || chauffeur.currentBookingId})`
  );
}

let distance = 5;
if (chauffeur.position && chauffeur.position.latitude && reservation.departCoords) {
  distance = calculerDistance(
    reservation.departCoords.lat,
    reservation.departCoords.lng,
    chauffeur.position.latitude,
    chauffeur.position.longitude
  );
}

await db.collection('reservations').doc(reservationId).update({
  chauffeurAssigne: chauffeurId,
  nomChauffeur: `${chauffeur.prenom} ${chauffeur.nom}`,
  telephoneChauffeur: chauffeur.telephone,
  statut: 'assignee',
  dateAssignation: admin.firestore.FieldValue.serverTimestamp(),
  distanceChauffeur: Math.round(distance * 1000),
  tempsArriveeChauffeur: Math.round(distance * 3),
  modeAssignation: 'manuel',
  assignePar: context.auth.email
});

// ✅✅✅ SYNCHRONISATION AUTOMATIQUE ✅✅✅
console.log('🔄 SYNCHRONISATION: Mise à jour chauffeur avec currentBookingId + reservationEnCours');

await db.collection('drivers').doc(chauffeurId).update({
  statut: 'en_course',
  currentBookingId: reservationId,       // ← Pour l'app chauffeur
  reservationEnCours: reservationId,     // ← Pour les Cloud Functions
  derniereAssignation: admin.firestore.FieldValue.serverTimestamp()
});

console.log('✅ SYNCHRONISATION RÉUSSIE!');

await db.collection('notifications').add({
  chauffeurId: chauffeurId,
  destinataire: chauffeur.telephone,
  type: 'nouvelle_course',
  reservationId: reservationId,
  depart: reservation.depart,
  destination: reservation.destination,
  clientNom: reservation.clientNom,
  clientTelephone: reservation.clientTelephone,
  prixEstime: reservation.prixEstime,
  timestamp: admin.firestore.FieldValue.serverTimestamp(),
  lu: false
});

console.log(`✅ Assignation manuelle réussie: ${chauffeur.prenom} ${chauffeur.nom}`);

return { 
  success: true, 
  message: `Chauffeur ${chauffeur.prenom} ${chauffeur.nom} assigné avec succès`,
  chauffeur: {
    nom: `${chauffeur.prenom} ${chauffeur.nom}`,
    telephone: chauffeur.telephone,
    distance: distance.toFixed(2)
  }
};
} catch (error) {
console.error('❌ Erreur assignation manuelle:', error);
throw new functions.https.HttpsError('internal', error.message);
}
});
// ==========================================
// 3. SYSTÈME DE FALLBACK (Réassignation)
// ==========================================
exports.verifierAssignationTimeout = functions.pubsub
.schedule('every 5 minutes')
.onRun(async (context) => {
console.log('🔍 Vérification des réservations non acceptées...');
const params = await getSystemParams();
const maintenant = Date.now();
const timeout = params.delaiReassignation * 60 * 1000;

try {
  const snapshot = await db.collection('reservations')
    .where('statut', '==', 'assignee')
    .get();
  
  const promesses = [];
  
  snapshot.forEach(doc => {
    const reservation = doc.data();
    
    if (reservation.dateAssignation) {
      const tempsEcoule = maintenant - reservation.dateAssignation.toMillis();
      
      if (tempsEcoule > timeout) {
        console.log(`⚠️ Timeout détecté pour réservation ${doc.id} (${Math.round(tempsEcoule / 60000)} min écoulées)`);
        promesses.push(reassignerChauffeur(doc.id, reservation));
      }
    }
  });
  
  await Promise.all(promesses);
  
  if (promesses.length > 0) {
    console.log(`✅ ${promesses.length} réassignations effectuées`);
    
    await db.collection('notifications_admin').add({
      type: 'reassignations_automatiques',
      message: `${promesses.length} réservation(s) réassignée(s) automatiquement`,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      lu: false
    });
  }
  
} catch (error) {
  console.error('❌ Erreur vérification timeout:', error);
}

return null;
});
// ✅✅✅ FONCTION REASSIGNER CORRIGÉE ✅✅✅
async function reassignerChauffeur(reservationId, reservation) {
try {
if (reservation.chauffeurAssigne) {
console.log('🔄 SYNCHRONISATION: Libération complète du chauffeur (timeout)');
  // ✅ CORRECTION: Mettre à jour TOUS les champs
  await db.collection('drivers').doc(reservation.chauffeurAssigne).update({
    statut: 'disponible',
    currentBookingId: null,          // ← Ajouté !
    reservationEnCours: null         // ← Déjà présent
  });
  
  console.log('✅ SYNCHRONISATION RÉUSSIE!');
  
  await db.collection('notifications').add({
    chauffeurId: reservation.chauffeurAssigne,
    type: 'course_retiree',
    reservationId: reservationId,
    message: 'Course retirée suite à un délai d\'acceptation dépassé',
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    lu: false
  });
}

await db.collection('reservations').doc(reservationId).update({
  statut: 'en_attente',
  chauffeurAssigne: null,
  nomChauffeur: null,
  telephoneChauffeur: null,
  dateAssignation: null,
  chauffeursRefuses: admin.firestore.FieldValue.arrayUnion(reservation.chauffeurAssigne || ''),
  tentativesAssignation: admin.firestore.FieldValue.increment(1)
});

console.log(`✅ Réservation ${reservationId} réinitialisée et prête pour réassignation`);
} catch (error) {
console.error(❌ Erreur réassignation ${reservationId}:, error);
}
}
// ==========================================
// 4. TERMINER UNE COURSE
// ==========================================
exports.terminerCourse = functions.https.onCall(async (data, context) => {
if (!context.auth) {
throw new functions.https.HttpsError('unauthenticated', 'Non authentifié');
}
const { reservationId, chauffeurId } = data;
try {
await db.collection('reservations').doc(reservationId).update({
statut: 'terminee',
dateTerminaison: admin.firestore.FieldValue.serverTimestamp()
});
// ✅✅✅ SYNCHRONISATION AUTOMATIQUE ✅✅✅
console.log('🔄 SYNCHRONISATION: Libération complète du chauffeur (course terminée)');

await db.collection('drivers').doc(chauffeurId).update({
  statut: 'disponible',
  currentBookingId: null,              // ← Ajouté !
  reservationEnCours: null,            // ← Déjà présent
  coursesCompletees: admin.firestore.FieldValue.increment(1)
});

console.log('✅ SYNCHRONISATION RÉUSSIE!');

return { success: true, message: 'Course terminée avec succès' };
} catch (error) {
throw new functions.https.HttpsError('internal', error.message);
}
});
// ==========================================
// 5. ANNULER UNE RÉSERVATION
// ==========================================
exports.annulerReservation = functions.https.onCall(async (data, context) => {
if (!context.auth) {
throw new functions.https.HttpsError('unauthenticated', 'Non authentifié');
}
const { reservationId, raison } = data;
try {
const reservationDoc = await db.collection('reservations').doc(reservationId).get();
const reservation = reservationDoc.data();
if (reservation.chauffeurAssigne) {
  // ✅✅✅ SYNCHRONISATION AUTOMATIQUE ✅✅✅
  console.log('🔄 SYNCHRONISATION: Libération complète du chauffeur (annulation)');
  
  await db.collection('drivers').doc(reservation.chauffeurAssigne).update({
    statut: 'disponible',
    currentBookingId: null,          // ← Ajouté !
    reservationEnCours: null         // ← Déjà présent
  });
  
  console.log('✅ SYNCHRONISATION RÉUSSIE!');
}

await db.collection('reservations').doc(reservationId).update({
  statut: 'annulee',
  raisonAnnulation: raison || 'Non spécifiée',
  dateAnnulation: admin.firestore.FieldValue.serverTimestamp(),
  annuleePar: context.auth.email
});

return { success: true, message: 'Réservation annulée' };
} catch (error) {
throw new functions.https.HttpsError('internal', error.message);
}
});
// ==========================================
// 6. VÉRIFICATION DE COHÉRENCE (NOUVEAU)
// ==========================================
exports.verifierCoherenceChauffeurs = functions.pubsub
.schedule('every 1 hours')
.onRun(async (context) => {
console.log('🔍 Vérification de cohérence des chauffeurs...');
try {
  const snapshot = await db.collection('drivers').get();
  let incohérences = 0;
  
  const corrections = [];
  
  snapshot.forEach(doc => {
    const data = doc.data();
    
    // ✅ Vérifier l'incohérence
    if (data.currentBookingId !== data.reservationEnCours) {
      console.log(`⚠️ INCOHÉRENCE détectée pour ${doc.id}:`);
      console.log(`   currentBookingId: ${data.currentBookingId}`);
      console.log(`   reservationEnCours: ${data.reservationEnCours}`);
      
      incohérences++;
      
      // Correction automatique : prendre la valeur non-null si une seule existe
      let valeurCorrecte = null;
      
      if (data.currentBookingId && !data.reservationEnCours) {
        valeurCorrecte = data.currentBookingId;
      } else if (data.reservationEnCours && !data.currentBookingId) {
        valeurCorrecte = data.reservationEnCours;
      } else if (data.currentBookingId && data.reservationEnCours) {
        // Les deux existent mais sont différents - prendre currentBookingId (plus récent)
        valeurCorrecte = data.currentBookingId;
      } else {
        // Les deux sont null - OK, synchronisés
        return;
      }
      
      console.log(`🔧 Correction automatique: ${valeurCorrecte}`);
      
      corrections.push(
        db.collection('drivers').doc(doc.id).update({
          currentBookingId: valeurCorrecte,
          reservationEnCours: valeurCorrecte
        })
      );
    }
  });
  
  if (corrections.length > 0) {
    await Promise.all(corrections);
    console.log(`✅ ${corrections.length} incohérence(s) corrigée(s) automatiquement`);
    
    await db.collection('notifications_admin').add({
      type: 'coherence_corrigee',
      message: `${corrections.length} chauffeur(s) synchronisé(s) automatiquement`,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      lu: false
    });
  } else {
    console.log('✅ Tous les chauffeurs sont cohérents');
  }
  
} catch (error) {
  console.error('❌ Erreur vérification cohérence:', error);
}

return null;
});
// ==========================================
// FONCTIONS UTILITAIRES
// ==========================================
function calculerDistance(lat1, lng1, lat2, lng2) {
const R = 6371;
const dLat = toRad(lat2 - lat1);
const dLng = toRad(lng2 - lng1);
const a =
Math.sin(dLat / 2) * Math.sin(dLat / 2) +
Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
Math.sin(dLng / 2) * Math.sin(dLng / 2);
const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
return R * c;
}
function toRad(valeur) {
return valeur * Math.PI / 180;
}
function getDefaultCoordsForAddress(address) {
const coords = {
'plateau': { lat: 14.6928, lng: -17.4467 },
'almadies': { lat: 14.7247, lng: -17.5050 },
'sacre-coeur': { lat: 14.6937, lng: -17.4441 },
'mermoz': { lat: 14.7108, lng: -17.4682 },
'hlm': { lat: 14.7306, lng: -17.4542 },
'yoff': { lat: 14.7500, lng: -17.4833 },
'ouakam': { lat: 14.7200, lng: -17.4900 },
'liberte': { lat: 14.7186, lng: -17.4697 },
'medina': { lat: 14.6738, lng: -17.4387 },
'parcelles': { lat: 14.7369, lng: -17.4731 },
'grand-dakar': { lat: 14.6928, lng: -17.4580 },
'fann': { lat: 14.6872, lng: -17.4535 },
'point-e': { lat: 14.6953, lng: -17.4614 },
'amitie': { lat: 14.7014, lng: -17.4647 },
'ngor': { lat: 14.7517, lng: -17.5192 },
'virage': { lat: 14.7314, lng: -17.4636 },
'sicap': { lat: 14.7289, lng: -17.4594 }
};
const addressLower = address.toLowerCase();
for (const [quartier, coordonnees] of Object.entries(coords)) {
if (addressLower.includes(quartier)) {
return coordonnees;
}
}
return { lat: 14.6928, lng: -17.4467 };
}
</artifact>
