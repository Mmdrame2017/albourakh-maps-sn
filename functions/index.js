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
// 1. ASSIGNATION AUTOMATIQUE (CORRIGÉE)
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
    
    // 🔥 VÉRIFIER SI L'ASSIGNATION AUTO EST ACTIVÉE
    const params = await getSystemParams();
    
    if (!params.assignationAutomatique) {
      console.log('🔴 Mode MANUEL activé - Pas d\'assignation automatique');
      
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
    
    console.log('🟢 Mode AUTO activé - Assignation automatique en cours...');
    
    try {
      // ✅ CORRECTION #1 : Utiliser la bonne collection 'drivers'
      const chauffeursSnapshot = await db.collection('drivers')
        .where('statut', '==', 'disponible')  // ✅ Bon champ
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
      
      // ✅ CORRECTION #2 : Géocoder l'adresse de départ pour obtenir lat/lng
      let departCoords = null;
      
      // Option A : Si vous avez déjà les coordonnées dans la réservation
      if (reservation.departCoords) {
        departCoords = reservation.departCoords;
      } 
      // Option B : Géocoder l'adresse (nécessite Google Maps Geocoding API)
      else {
        console.log('⚠️ Pas de coordonnées GPS, utilisation de l\'approximation');
        // Fallback sur approximation si pas de coords
        departCoords = getDefaultCoordsForAddress(reservation.depart);
      }
      
      // ✅ CORRECTION #3 : Calculer les VRAIES distances GPS
      const chauffeurs = [];
      
      chauffeursSnapshot.forEach(doc => {
        const chauffeur = doc.data();
        
        // Vérifier que le chauffeur a une position GPS
        if (!chauffeur.position || !chauffeur.position.latitude) {
          console.log(`⚠️ Chauffeur ${doc.id} sans position GPS`);
          return; // Skip ce chauffeur
        }
        
        // ✅ UTILISER LA VRAIE FONCTION GPS
        const distance = calculerDistance(
          departCoords.lat,
          departCoords.lng,
          chauffeur.position.latitude,
          chauffeur.position.longitude
        );
        
        console.log(`📍 ${chauffeur.prenom} ${chauffeur.nom} : ${distance.toFixed(2)} km`);
        
        // Filtrer par rayon de recherche
        if (distance <= params.rayonRecherche) {
          chauffeurs.push({
            id: doc.id,
            ...chauffeur,
            distance: distance
          });
        }
      });
      
      if (chauffeurs.length === 0) {
        console.log(`❌ Aucun chauffeur dans un rayon de ${params.rayonRecherche} km`);
        
        await db.collection('notifications_admin').add({
          type: 'aucun_chauffeur_proximite',
          reservationId: reservationId,
          message: `Aucun chauffeur trouvé dans un rayon de ${params.rayonRecherche} km`,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          lu: false
        });
        
        return null;
      }
      
      // Trier par distance croissante
      chauffeurs.sort((a, b) => a.distance - b.distance);
      
      const chauffeurChoisi = chauffeurs[0];
      
      console.log(`✅ Chauffeur sélectionné: ${chauffeurChoisi.prenom} ${chauffeurChoisi.nom} (${chauffeurChoisi.distance.toFixed(2)} km)`);
      
      // ✅ CORRECTION #4 : Utiliser les bons noms de champs
      await snap.ref.update({
        chauffeurAssigne: chauffeurChoisi.id,
        nomChauffeur: `${chauffeurChoisi.prenom} ${chauffeurChoisi.nom}`,  // ✅ Construit depuis prenom/nom
        telephoneChauffeur: chauffeurChoisi.telephone,
        statut: 'assignee',
        dateAssignation: admin.firestore.FieldValue.serverTimestamp(),
        distanceChauffeur: Math.round(chauffeurChoisi.distance * 1000), // en mètres
        tempsArriveeChauffeur: Math.round(chauffeurChoisi.distance * 3), // 3 min/km
        modeAssignation: 'automatique'
      });
      
      // ✅ Mettre à jour le chauffeur - Bon champ 'statut'
      await db.collection('drivers').doc(chauffeurChoisi.id).update({
        statut: 'en_course',  // ✅ Pas 'disponible: false'
        reservationEnCours: reservationId,
        derniereAssignation: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Créer une notification pour le chauffeur
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
      
      // Notification admin (succès)
      await db.collection('notifications_admin').add({
        type: 'assignation_reussie',
        reservationId: reservationId,
        message: `✅ ${chauffeurChoisi.prenom} ${chauffeurChoisi.nom} assigné automatiquement (${chauffeurChoisi.distance.toFixed(1)} km)`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        lu: false
      });
      
      console.log(`✅ Assignation automatique réussie!`);
      
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
// 2. ASSIGNATION MANUELLE (CORRIGÉE)
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
    
    // Si un chauffeur était déjà assigné, le rendre disponible
    if (reservation.chauffeurAssigne) {
      await db.collection('drivers').doc(reservation.chauffeurAssigne).update({
        statut: 'disponible',  // ✅ Bon champ
        reservationEnCours: null
      });
    }
    
    // ✅ Récupérer depuis 'drivers'
    const chauffeurDoc = await db.collection('drivers').doc(chauffeurId).get();
    if (!chauffeurDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Chauffeur non trouvé');
    }
    
    const chauffeur = chauffeurDoc.data();
    
    // Calculer la distance si possible
    let distance = 5; // Défaut
    if (chauffeur.position && chauffeur.position.latitude && reservation.departCoords) {
      distance = calculerDistance(
        reservation.departCoords.lat,
        reservation.departCoords.lng,
        chauffeur.position.latitude,
        chauffeur.position.longitude
      );
    }
    
    // Mettre à jour la réservation
    await db.collection('reservations').doc(reservationId).update({
      chauffeurAssigne: chauffeurId,
      nomChauffeur: `${chauffeur.prenom} ${chauffeur.nom}`,  // ✅
      telephoneChauffeur: chauffeur.telephone,
      statut: 'assignee',
      dateAssignation: admin.firestore.FieldValue.serverTimestamp(),
      distanceChauffeur: Math.round(distance * 1000),
      tempsArriveeChauffeur: Math.round(distance * 3),
      modeAssignation: 'manuel',
      assignePar: context.auth.email
    });
    
    // ✅ Mettre à jour le chauffeur
    await db.collection('drivers').doc(chauffeurId).update({
      statut: 'en_course',  // ✅
      reservationEnCours: reservationId,
      derniereAssignation: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Notification chauffeur
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
// 3. SYSTÈME DE FALLBACK (CORRIGÉ)
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
            console.log(`⚠️ Timeout détecté pour réservation ${doc.id}`);
            promesses.push(reassignerChauffeur(doc.id, reservation));
          }
        }
      });
      
      await Promise.all(promesses);
      
      if (promesses.length > 0) {
        console.log(`✅ ${promesses.length} réassignations effectuées`);
      }
      
    } catch (error) {
      console.error('❌ Erreur vérification timeout:', error);
    }
    
    return null;
  });

async function reassignerChauffeur(reservationId, reservation) {
  try {
    if (reservation.chauffeurAssigne) {
      // ✅ Libérer le chauffeur
      await db.collection('drivers').doc(reservation.chauffeurAssigne).update({
        statut: 'disponible',  // ✅
        reservationEnCours: null
      });
      
      await db.collection('notifications').add({
        chauffeurId: reservation.chauffeurAssigne,
        type: 'course_retiree',
        reservationId: reservationId,
        message: 'Course retirée suite à un délai d\'acceptation dépassé',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        lu: false
      });
    }
    
    // Réinitialiser la réservation
    await db.collection('reservations').doc(reservationId).update({
      statut: 'en_attente',
      chauffeurAssigne: null,
      nomChauffeur: null,
      telephoneChauffeur: null,
      dateAssignation: null,
      chauffeursRefuses: admin.firestore.FieldValue.arrayUnion(reservation.chauffeurAssigne || ''),
      tentativesAssignation: admin.firestore.FieldValue.increment(1)
    });
    
    console.log(`✅ Réservation ${reservationId} réinitialisée`);
    
  } catch (error) {
    console.error(`❌ Erreur réassignation ${reservationId}:`, error);
  }
}

// ==========================================
// 4. TERMINER UNE COURSE (CORRIGÉ)
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
    
    // ✅ Libérer le chauffeur
    await db.collection('drivers').doc(chauffeurId).update({
      statut: 'disponible',  // ✅
      reservationEnCours: null,
      coursesCompletees: admin.firestore.FieldValue.increment(1)
    });
    
    return { success: true, message: 'Course terminée avec succès' };
    
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ==========================================
// 5. ANNULER UNE RÉSERVATION (CORRIGÉ)
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
      // ✅ Libérer le chauffeur
      await db.collection('drivers').doc(reservation.chauffeurAssigne).update({
        statut: 'disponible',  // ✅
        reservationEnCours: null
      });
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
// FONCTIONS UTILITAIRES
// ==========================================

// ✅ Formule GPS Haversine (UTILISÉE maintenant)
function calculerDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Rayon de la Terre en km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  
  return distance;
}

function toRad(valeur) {
  return valeur * Math.PI / 180;
}

// Coordonnées par défaut des quartiers de Dakar (fallback)
function getDefaultCoordsForAddress(address) {
  const coords = {
    'plateau': { lat: 14.6928, lng: -17.4467 },
    'almadies': { lat: 14.7247, lng: -17.5050 },
    'sacre-coeur': { lat: 14.6937, lng: -17.4441 },
    'mermoz': { lat: 14.7108, lng: -17.4682 },
    'hlm': { lat: 14.7306, lng: -17.4542 },
    'yoff': { lat: 14.7500, lng: -17.4833 },
    'ouakam': { lat: 14.7200, lng: -17.4900 },
  };
  
  const addressLower = address.toLowerCase();
  for (const [quartier, coordonnees] of Object.entries(coords)) {
    if (addressLower.includes(quartier)) {
      return coordonnees;
    }
  }
  
  // Par défaut : Plateau
  return { lat: 14.6928, lng: -17.4467 };
}
