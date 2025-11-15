const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

// ==========================================
// CONFIGURATION SYSTÈME
// ==========================================

// Obtenir les paramètres système
async function getSystemParams() {
  try {
    const doc = await db.collection('parametres').doc('config').get();
    if (doc.exists) {
      return doc.data();
    }
    // Valeurs par défaut si pas encore configuré
    return {
      assignationAutomatique: true,
      delaiReassignation: 10, // minutes
      rayonRecherche: 10, // km
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
// 1. ASSIGNATION AUTOMATIQUE (MODE HYBRIDE)
// ==========================================

exports.assignerChauffeurAutomatique = functions.firestore
  .document('reservations/{reservationId}')
  .onCreate(async (snap, context) => {
    const reservation = snap.data();
    const reservationId = context.params.reservationId;
    
    console.log(`🚕 Nouvelle réservation détectée: ${reservationId}`);
    
    // Vérifier le statut de la réservation
    if (reservation.statut !== 'en_attente') {
      console.log('⚠️ Réservation déjà traitée');
      return null;
    }
    
    // 🔥 VÉRIFIER SI L'ASSIGNATION AUTO EST ACTIVÉE
    const params = await getSystemParams();
    
    if (!params.assignationAutomatique) {
      console.log('🔴 Mode MANUEL activé - Pas d\'assignation automatique');
      
      // Créer une notification pour l'admin
      await db.collection('notifications_admin').add({
        type: 'nouvelle_reservation_manuelle',
        reservationId: reservationId,
        message: `Nouvelle réservation en attente - Mode manuel activé`,
        clientNom: reservation.nom,
        depart: reservation.depart,
        destination: reservation.destination,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        lu: false
      });
      
      return null;
    }
    
    console.log('🟢 Mode AUTO activé - Assignation automatique en cours...');
    
    // Continuer avec l'assignation automatique
    try {
      // Trouver les chauffeurs disponibles
      const chauffeursSnapshot = await db.collection('candidatures_chauffeurs')
        .where('disponible', '==', true)
        .where('statut', '==', 'acceptee')
        .get();
      
      if (chauffeursSnapshot.empty) {
        console.log('❌ Aucun chauffeur disponible');
        
        // Créer une notification pour l'admin
        await db.collection('notifications_admin').add({
          type: 'aucun_chauffeur',
          reservationId: reservationId,
          message: `Aucun chauffeur disponible - Assignation manuelle requise`,
          clientNom: reservation.nom,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          lu: false
        });
        
        return null;
      }
      
      // Calculer les distances et trouver le plus proche
      const chauffeurs = [];
      chauffeursSnapshot.forEach(doc => {
        const chauffeur = doc.data();
        // Utiliser la ville de résidence comme approximation
        const distance = estimerDistanceParVille(reservation.depart, chauffeur.villeResidence);
        
        // Filtrer par rayon de recherche
        if (distance <= params.rayonRecherche) {
          chauffeurs.push({
            id: doc.id,
            ...chauffeur,
            distance: distance
          });
        }
      });
      
      // Trier par distance croissante
      chauffeurs.sort((a, b) => a.distance - b.distance);
      
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
      
      // Assigner le chauffeur le plus proche
      const chauffeurChoisi = chauffeurs[0];
      
      // Mettre à jour la réservation
      await snap.ref.update({
        chauffeurAssigne: chauffeurChoisi.id,
        nomChauffeur: chauffeurChoisi.nomComplet,
        telephoneChauffeur: chauffeurChoisi.telephone,
        statut: 'assignee',
        dateAssignation: admin.firestore.FieldValue.serverTimestamp(),
        distanceChauffeur: chauffeurChoisi.distance,
        tempsArriveeChauffeur: Math.round(chauffeurChoisi.distance * 3), // 3 min par km
        modeAssignation: 'automatique'
      });
      
      // Mettre à jour le chauffeur
      await db.collection('candidatures_chauffeurs').doc(chauffeurChoisi.id).update({
        disponible: false,
        coursesEnCours: admin.firestore.FieldValue.increment(1),
        derniereAssignation: admin.firestore.FieldValue.serverTimestamp()
      });
      
      // Créer une notification pour le chauffeur
      await db.collection('notifications_chauffeur').add({
        chauffeurId: chauffeurChoisi.id,
        type: 'nouvelle_course',
        reservationId: reservationId,
        depart: reservation.depart,
        destination: reservation.destination,
        clientNom: reservation.nom,
        clientTelephone: reservation.telephone,
        prixEstime: reservation.prixEstime,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        lu: false
      });
      
      // Notification admin (succès)
      await db.collection('notifications_admin').add({
        type: 'assignation_reussie',
        reservationId: reservationId,
        message: `✅ ${chauffeurChoisi.nomComplet} assigné automatiquement (${chauffeurChoisi.distance.toFixed(1)} km)`,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        lu: false
      });
      
      console.log(`✅ Chauffeur ${chauffeurChoisi.nomComplet} assigné automatiquement`);
      
      return null;
      
    } catch (error) {
      console.error('❌ Erreur assignation:', error);
      
      await db.collection('erreurs_systeme').add({
        type: 'erreur_assignation_auto',
        reservationId: reservationId,
        message: error.message,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      
      return null;
    }
  });

// ==========================================
// 2. ASSIGNATION MANUELLE (HTTP Function)
// ==========================================

exports.assignerChauffeurManuel = functions.https.onCall(async (data, context) => {
  // Vérifier que l'utilisateur est authentifié et admin
  if (!context.auth) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Utilisateur non authentifié'
    );
  }
  
  const { reservationId, chauffeurId } = data;
  
  if (!reservationId || !chauffeurId) {
    throw new functions.https.HttpsError(
      'invalid-argument',
      'reservationId et chauffeurId requis'
    );
  }
  
  try {
    // Récupérer la réservation
    const reservationDoc = await db.collection('reservations').doc(reservationId).get();
    if (!reservationDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Réservation non trouvée');
    }
    
    const reservation = reservationDoc.data();
    
    // Si un chauffeur était déjà assigné, le rendre disponible
    if (reservation.chauffeurAssigne) {
      await db.collection('candidatures_chauffeurs')
        .doc(reservation.chauffeurAssigne)
        .update({
          disponible: true,
          coursesEnCours: admin.firestore.FieldValue.increment(-1)
        });
    }
    
    // Récupérer les infos du nouveau chauffeur
    const chauffeurDoc = await db.collection('candidatures_chauffeurs').doc(chauffeurId).get();
    if (!chauffeurDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Chauffeur non trouvé');
    }
    
    const chauffeur = chauffeurDoc.data();
    
    // Calculer la distance estimée
    const distance = estimerDistanceParVille(reservation.depart, chauffeur.villeResidence);
    
    // Mettre à jour la réservation
    await db.collection('reservations').doc(reservationId).update({
      chauffeurAssigne: chauffeurId,
      nomChauffeur: chauffeur.nomComplet,
      telephoneChauffeur: chauffeur.telephone,
      statut: 'assignee',
      dateAssignation: admin.firestore.FieldValue.serverTimestamp(),
      distanceChauffeur: distance,
      tempsArriveeChauffeur: Math.round(distance * 3),
      modeAssignation: 'manuel',
      assignePar: context.auth.email
    });
    
    // Mettre à jour le chauffeur
    await db.collection('candidatures_chauffeurs').doc(chauffeurId).update({
      disponible: false,
      coursesEnCours: admin.firestore.FieldValue.increment(1),
      derniereAssignation: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Créer une notification pour le chauffeur
    await db.collection('notifications_chauffeur').add({
      chauffeurId: chauffeurId,
      type: 'nouvelle_course',
      reservationId: reservationId,
      depart: reservation.depart,
      destination: reservation.destination,
      clientNom: reservation.nom,
      clientTelephone: reservation.telephone,
      prixEstime: reservation.prixEstime,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      lu: false
    });
    
    console.log(`✅ Assignation manuelle réussie: ${chauffeur.nomComplet}`);
    
    return { 
      success: true, 
      message: `Chauffeur ${chauffeur.nomComplet} assigné avec succès`,
      chauffeur: {
        nom: chauffeur.nomComplet,
        telephone: chauffeur.telephone,
        distance: distance
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
    const timeout = params.delaiReassignation * 60 * 1000; // Convertir minutes en ms
    
    try {
      // Trouver les réservations assignées mais pas acceptées depuis > timeout
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
            promesses.push(reassignerChauffeur(doc.id, reservation, params));
          }
        }
      });
      
      await Promise.all(promesses);
      
      if (promesses.length > 0) {
        console.log(`✅ ${promesses.length} réassignations effectuées`);
        
        // Notifier l'admin
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

// Fonction de réassignation
async function reassignerChauffeur(reservationId, reservation, params) {
  try {
    // Rendre le chauffeur précédent disponible
    if (reservation.chauffeurAssigne) {
      await db.collection('candidatures_chauffeurs')
        .doc(reservation.chauffeurAssigne)
        .update({
          disponible: true,
          coursesEnCours: admin.firestore.FieldValue.increment(-1)
        });
      
      // Notifier le chauffeur
      await db.collection('notifications_chauffeur').add({
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
      tentativesAssignation: admin.firestore.FieldValue.increment(1)
    });
    
    console.log(`✅ Réservation ${reservationId} réinitialisée`);
    
  } catch (error) {
    console.error(`❌ Erreur réassignation ${reservationId}:`, error);
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
    // Mettre à jour la réservation
    await db.collection('reservations').doc(reservationId).update({
      statut: 'terminee',
      dateTerminaison: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Rendre le chauffeur disponible et incrémenter ses stats
    await db.collection('candidatures_chauffeurs').doc(chauffeurId).update({
      disponible: true,
      coursesEnCours: admin.firestore.FieldValue.increment(-1),
      totalCourses: admin.firestore.FieldValue.increment(1)
    });
    
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
    
    // Si un chauffeur était assigné, le rendre disponible
    if (reservation.chauffeurAssigne) {
      await db.collection('candidatures_chauffeurs')
        .doc(reservation.chauffeurAssigne)
        .update({
          disponible: true,
          coursesEnCours: admin.firestore.FieldValue.increment(-1)
        });
    }
    
    // Mettre à jour la réservation
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

// Estimer la distance basée sur la ville
function estimerDistanceParVille(depart, villeResidence) {
  // Distances approximatives en km depuis différents points de Dakar
  const distances = {
    'Dakar': 5,
    'Pikine': 12,
    'Guédiawaye': 15,
    'Rufisque': 20,
    'Thiès': 70,
    'Kaolack': 200,
    'Saint-Louis': 260
  };
  
  // Chercher la ville dans le nom de départ ou ville de résidence
  for (const [ville, dist] of Object.entries(distances)) {
    if (depart?.toLowerCase().includes(ville.toLowerCase()) || 
        villeResidence?.toLowerCase().includes(ville.toLowerCase())) {
      return dist;
    }
  }
  
  // Par défaut, supposer que c'est dans Dakar
  return 5;
}

// Calculer la distance entre deux points GPS (formule Haversine)
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
  
  return distance; // Distance en kilomètres
}

function toRad(valeur) {
  return valeur * Math.PI / 180;
}
