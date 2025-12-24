const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

// ==========================================
// CONFIGURATION SYSTÈME
// ==========================================

// ⭐ NOUVEAU : Seuil minimum de portefeuille pour assignation
const MINIMUM_WALLET_BALANCE = 1000; // en FCFA

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
// 1. ASSIGNATION AUTOMATIQUE (avec contrôle portefeuille)
// ==========================================
exports.assignerChauffeurAutomatique = functions.firestore
  .document('reservations/{reservationId}')
  .onCreate(async (snap, context) => {
    const reservation = snap.data();
    const reservationId = context.params.reservationId;
    
    console.log(`🚕 [${new Date().toISOString()}] Nouvelle réservation: ${reservationId}`);

    if (reservation.statut !== 'en_attente') {
      console.log('⚠️ Réservation déjà traitée');
      return null;
    }

    const params = await getSystemParams();

    if (!params.assignationAutomatique) {
      console.log('🔴 MODE MANUEL activé');
      
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

    console.log('🟢 MODE AUTO activé');

    try {
      const chauffeursSnapshot = await db.collection('drivers')
        .where('statut', '==', 'disponible')
        .get();
      
      if (chauffeursSnapshot.empty) {
        console.log('❌ Aucun chauffeur disponible');
        
        await db.collection('notifications_admin').add({
          type: 'aucun_chauffeur',
          reservationId: reservationId,
          message: `Aucun chauffeur disponible`,
          clientNom: reservation.clientNom,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          lu: false
        });
        
        return null;
      }
      
      let departCoords = null;
      let coordonneesApproximatives = false;
      
      if (reservation.departCoords && reservation.departCoords.lat && reservation.departCoords.lng) {
        departCoords = reservation.departCoords;
      } else {
        console.log(`⚠️ Coordonnées manquantes pour: ${reservation.depart}`);
        departCoords = getDefaultCoordsForAddress(reservation.depart);
        coordonneesApproximatives = true;
        
        await snap.ref.update({
          departCoords: departCoords,
          coordonneesApproximatives: true
        });
      }
      
      const chauffeurs = [];
      let chauffeursExclusParSolde = 0;
      
      chauffeursSnapshot.forEach(doc => {
        const chauffeur = doc.data();
        
        // ✅ NOUVEAU : Vérification du solde du portefeuille
        const walletBalance = chauffeur.portefeuille?.solde || 0;
        
        if (walletBalance < MINIMUM_WALLET_BALANCE) {
          console.log(`💰 ${doc.id} (${chauffeur.prenom} ${chauffeur.nom}): EXCLU - Solde insuffisant (${walletBalance} FCFA < ${MINIMUM_WALLET_BALANCE} FCFA)`);
          chauffeursExclusParSolde++;
          return; // Passer au suivant
        }
        
        if (!chauffeur.position || !chauffeur.position.latitude) {
          console.log(`⚠️ ${doc.id}: pas de GPS`);
          return;
        }
        
        if (chauffeur.reservationEnCours || chauffeur.currentBookingId) {
          console.log(`⚠️ ${doc.id}: déjà en course`);
          return;
        }
        
        const distance = calculerDistance(
          departCoords.lat,
          departCoords.lng,
          chauffeur.position.latitude,
          chauffeur.position.longitude
        );
        
        console.log(`📍 ${chauffeur.prenom} ${chauffeur.nom}: ${distance.toFixed(2)} km | 💰 Solde: ${walletBalance} FCFA`);
        
        if (distance <= params.rayonRecherche) {
          chauffeurs.push({
            id: doc.id,
            ...chauffeur,
            distance: distance,
            walletBalance: walletBalance
          });
        }
      });
      
      // ✅ NOUVEAU : Notification si des chauffeurs exclus pour solde insuffisant
      if (chauffeursExclusParSolde > 0) {
        console.log(`⚠️ ${chauffeursExclusParSolde} chauffeur(s) exclu(s) pour solde insuffisant`);
        
        await db.collection('notifications_admin').add({
          type: 'chauffeurs_exclus_solde',
          reservationId: reservationId,
          message: `${chauffeursExclusParSolde} chauffeur(s) disponible(s) mais avec solde < ${MINIMUM_WALLET_BALANCE} FCFA`,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          lu: false
        });
      }
      
      if (chauffeurs.length === 0) {
        console.log(`❌ Aucun chauffeur éligible dans ${params.rayonRecherche} km`);
        
        const messageDetail = chauffeursExclusParSolde > 0 
          ? `Aucun chauffeur dans ${params.rayonRecherche} km avec solde suffisant (${chauffeursExclusParSolde} exclu(s))`
          : `Aucun chauffeur dans ${params.rayonRecherche} km`;
        
        await db.collection('notifications_admin').add({
          type: 'aucun_chauffeur_proximite',
          reservationId: reservationId,
          message: messageDetail,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          lu: false
        });
        
        return null;
      }
      
      chauffeurs.sort((a, b) => a.distance - b.distance);
      const chauffeurChoisi = chauffeurs[0];
      
      console.log(`✅ Sélectionné: ${chauffeurChoisi.prenom} ${chauffeurChoisi.nom} (${chauffeurChoisi.distance.toFixed(2)} km | 💰 ${chauffeurChoisi.walletBalance} FCFA)`);
      
      await db.runTransaction(async (transaction) => {
        const chauffeurRef = db.collection('drivers').doc(chauffeurChoisi.id);
        const chauffeurDoc = await transaction.get(chauffeurRef);
        const chauffeurData = chauffeurDoc.data();
        
        // ✅ NOUVEAU : Vérification finale du solde avant assignation
        const finalWalletBalance = chauffeurData.portefeuille?.solde || 0;
        
        if (finalWalletBalance < MINIMUM_WALLET_BALANCE) {
          throw new Error(`Solde insuffisant: ${finalWalletBalance} FCFA < ${MINIMUM_WALLET_BALANCE} FCFA`);
        }
        
        if (chauffeurData.statut !== 'disponible' || 
            chauffeurData.currentBookingId || 
            chauffeurData.reservationEnCours) {
          throw new Error('Chauffeur plus disponible');
        }
        
        transaction.update(snap.ref, {
          chauffeurAssigne: chauffeurChoisi.id,
          nomChauffeur: `${chauffeurChoisi.prenom} ${chauffeurChoisi.nom}`,
          telephoneChauffeur: chauffeurChoisi.telephone,
          statut: 'assignee',
          dateAssignation: admin.firestore.FieldValue.serverTimestamp(),
          distanceChauffeur: Math.round(chauffeurChoisi.distance * 1000),
          tempsArriveeChauffeur: Math.round(chauffeurChoisi.distance * 3),
          modeAssignation: 'automatique',
          chauffeurWalletBalance: finalWalletBalance // ✅ NOUVEAU : Tracer le solde au moment de l'assignation
        });
        
        transaction.update(chauffeurRef, {
          statut: 'en_course',
          currentBookingId: reservationId,
          reservationEnCours: reservationId,
          derniereAssignation: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      
      console.log('✅ TRANSACTION RÉUSSIE');
      
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
        message: `✅ ${chauffeurChoisi.prenom} ${chauffeurChoisi.nom} assigné (${chauffeurChoisi.distance.toFixed(1)} km | 💰 ${chauffeurChoisi.walletBalance} FCFA)${coordonneesApproximatives ? ' - Coords approx.' : ''}`,
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
// 2. ASSIGNATION MANUELLE (avec contrôle portefeuille)
// ==========================================
exports.assignerChauffeurManuel = functions.https.onCall(async (data, context) => {
  if (!context.auth && !data.adminToken) {
    throw new functions.https.HttpsError('unauthenticated', 'Non authentifié');
  }
  
  const { reservationId, chauffeurId } = data;
  
  if (!reservationId || !chauffeurId) {
    throw new functions.https.HttpsError('invalid-argument', 'Paramètres manquants');
  }
  
  try {
    const reservationDoc = await db.collection('reservations').doc(reservationId).get();
    
    if (!reservationDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Réservation non trouvée');
    }
    
    const reservation = reservationDoc.data();

    if (reservation.chauffeurAssigne && reservation.chauffeurAssigne !== chauffeurId) {
      console.log('🔄 Libération ancien chauffeur');
      
      try {
        await db.collection('drivers').doc(reservation.chauffeurAssigne).update({
          statut: 'disponible',
          currentBookingId: null,
          reservationEnCours: null
        });
      } catch (err) {
        console.warn('⚠️ Impossible de libérer:', err.message);
      }
    }

    const chauffeurDoc = await db.collection('drivers').doc(chauffeurId).get();
    
    if (!chauffeurDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Chauffeur non trouvé');
    }

    const chauffeur = chauffeurDoc.data();

    // ✅ NOUVEAU : Vérification du solde du portefeuille
    const walletBalance = chauffeur.portefeuille?.solde || 0;
    
    if (walletBalance < MINIMUM_WALLET_BALANCE) {
      console.log(`❌ Assignation manuelle refusée: ${chauffeur.prenom} ${chauffeur.nom} - Solde insuffisant (${walletBalance} FCFA < ${MINIMUM_WALLET_BALANCE} FCFA)`);
      
      throw new functions.https.HttpsError(
        'failed-precondition', 
        `Solde du portefeuille insuffisant: ${walletBalance} FCFA (minimum requis: ${MINIMUM_WALLET_BALANCE} FCFA)`
      );
      }
      
      if (chauffeurCheckData.currentBookingId || chauffeurCheckData.reservationEnCours) {
        throw new Error('Chauffeur plus disponible');
      }
      
      transaction.update(reservationDoc.ref, {
    if (chauffeur.position && chauffeur.position.latitude && reservation.departCoords) {
      distance = calculerDistance(
        reservation.departCoords.lat,
        reservation.departCoords.lng,
        chauffeur.position.latitude,
        chauffeur.position.longitude
      );
    }

    await db.runTransaction(async (transaction) => {
      const chauffeurRef = db.collection('drivers').doc(chauffeurId);
      const chauffeurCheck = await transaction.get(chauffeurRef);
      const chauffeurCheckData = chauffeurCheck.data();
      
      // ✅ NOUVEAU : Vérification finale du solde dans la transaction
      const finalWalletBalance = chauffeurCheckData.portefeuille?.solde || 0;
      
      if (finalWalletBalance < MINIMUM_WALLET_BALANCE) {
        throw new Error(`Solde insuffisant: ${finalWalletBalance} FCFA < ${MINIMUM_WALLET_BALANCE} FCFA`);
      }
      
      if (chauffeurCheckData.currentBookingId || chauffeurCheckData.reservationEnCours) {
        throw new Error('Chauffeur plus disponible');
      }
      
      transaction.update(reservationDoc.ref, {
        chauffeurAssigne: chauffeurId,
        nomChauffeur: `${chauffeur.prenom} ${chauffeur.nom}`,
        telephoneChauffeur: chauffeur.telephone,
        statut: 'assignee',
        dateAssignation: admin.firestore.FieldValue.serverTimestamp(),
        distanceChauffeur: Math.round(distance * 1000),
        tempsArriveeChauffeur: Math.round(distance * 3),
        modeAssignation: 'manuel',
        assignePar: context.auth ? context.auth.email : 'admin',
        chauffeurWalletBalance: finalWalletBalance // ✅ NOUVEAU : Tracer le solde
      });

      transaction.update(chauffeurRef, {
        statut: 'en_course',
        currentBookingId: reservationId,
        reservationEnCours: reservationId,
        derniereAssignation: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    console.log(`✅ Assignation manuelle réussie: ${chauffeur.prenom} ${chauffeur.nom} (💰 ${walletBalance} FCFA)`);

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

    return { 
      success: true, 
      message: `${chauffeur.prenom} ${chauffeur.nom} assigné`,
      chauffeur: {
        nom: `${chauffeur.prenom} ${chauffeur.nom}`,
        telephone: chauffeur.telephone,
        distance: distance.toFixed(2),
        walletBalance: walletBalance // ✅ NOUVEAU : Retourner le solde
      }
    };
  } catch (error) {
    console.error('❌ Erreur:', error);
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ==========================================
// 3. SYSTÈME DE FALLBACK
// ==========================================
exports.verifierAssignationTimeout = functions.pubsub
  .schedule('every 5 minutes')
  .onRun(async (context) => {
    console.log('🔍 Vérification timeouts...');
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
            console.log(`⚠️ Timeout: ${doc.id}`);
            promesses.push(reassignerChauffeur(doc.id, reservation));
          }
        }
      });
      
      await Promise.all(promesses);
      
      if (promesses.length > 0) {
        console.log(`✅ ${promesses.length} réassignations`);
      }
      
    } catch (error) {
      console.error('❌ Erreur timeout:', error);
    }

    return null;
  });

async function reassignerChauffeur(reservationId, reservation) {
  try {
    if (reservation.chauffeurAssigne) {
      await db.collection('drivers').doc(reservation.chauffeurAssigne).update({
        statut: 'disponible',
        currentBookingId: null,
        reservationEnCours: null
      });
      
      await db.collection('notifications').add({
        chauffeurId: reservation.chauffeurAssigne,
        type: 'course_retiree',
        reservationId: reservationId,
        message: 'Course retirée (timeout)',
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

    console.log(`✅ Réservation ${reservationId} réinitialisée`);
  } catch (error) {
    console.error(`❌ Erreur réassignation ${reservationId}:`, error);
  }
}

// ==========================================
// 4. TERMINER UNE COURSE
// ==========================================
exports.terminerCourse = functions.https.onCall(async (data, context) => {
  if (!context.auth && !data.adminToken) {
    throw new functions.https.HttpsError('unauthenticated', 'Non authentifié');
  }
  
  const { reservationId, chauffeurId } = data;
  
  try {
    await db.collection('reservations').doc(reservationId).update({
      statut: 'terminee',
      dateTerminaison: admin.firestore.FieldValue.serverTimestamp()
    });
    
    await db.collection('drivers').doc(chauffeurId).update({
      statut: 'disponible',
      currentBookingId: null,
      reservationEnCours: null,
      coursesCompletees: admin.firestore.FieldValue.increment(1)
    });

    return { success: true, message: 'Course terminée' };
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ==========================================
// 5. ANNULER UNE RÉSERVATION
// ==========================================
exports.annulerReservation = functions.https.onCall(async (data, context) => {
  if (!context.auth && !data.adminToken) {
    throw new functions.https.HttpsError('unauthenticated', 'Non authentifié');
  }
  
  const { reservationId, raison } = data;
  
  try {
    const reservationDoc = await db.collection('reservations').doc(reservationId).get();
    const reservation = reservationDoc.data();
    
    if (reservation.chauffeurAssigne) {
      await db.collection('drivers').doc(reservation.chauffeurAssigne).update({
        statut: 'disponible',
        currentBookingId: null,
        reservationEnCours: null
      });
    }

    await db.collection('reservations').doc(reservationId).update({
      statut: 'annulee',
      raisonAnnulation: raison || 'Non spécifiée',
      dateAnnulation: admin.firestore.FieldValue.serverTimestamp(),
      annuleePar: context.auth ? context.auth.email : 'admin'
    });

    return { success: true, message: 'Réservation annulée' };
  } catch (error) {
    throw new functions.https.HttpsError('internal', error.message);
  }
});

// ==========================================
// 6. VÉRIFICATION DE COHÉRENCE
// ==========================================
exports.verifierCoherenceChauffeurs = functions.pubsub
  .schedule('every 1 hours')
  .onRun(async (context) => {
    console.log('🔍 Vérification cohérence...');
    
    try {
      const snapshot = await db.collection('drivers').get();
      const corrections = [];
      
      snapshot.forEach(doc => {
        const data = doc.data();
        
        if (data.currentBookingId !== data.reservationEnCours) {
          let valeurCorrecte = null;
          
          if (data.currentBookingId && !data.reservationEnCours) {
            valeurCorrecte = data.currentBookingId;
          } else if (data.reservationEnCours && !data.currentBookingId) {
            valeurCorrecte = data.reservationEnCours;
          } else if (data.currentBookingId && data.reservationEnCours) {
            valeurCorrecte = data.currentBookingId;
          } else {
            return;
          }
          
          console.log(`🔧 Correction: ${doc.id}`);
          
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
        console.log(`✅ ${corrections.length} corrections`);
      }
      
    } catch (error) {
      console.error('❌ Erreur cohérence:', error);
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

// ==========================================
// COORDONNÉES COMPLÈTES - 174 QUARTIERS DE DAKAR
// (129 quartiers de base + 45 quartiers de Keur Massar)
// ==========================================

function getDefaultCoordsForAddress(address) {
  const coords = {
    // ====================================
    // ZONE 1: DAKAR PLATEAU (15 quartiers)
    // ====================================
    'plateau': { lat: 14.6928, lng: -17.4467 },
    'place de l\'indépendance': { lat: 14.6928, lng: -17.4467 },
    'rebeuss': { lat: 14.6850, lng: -17.4450 },
    'port': { lat: 14.6800, lng: -17.4150 },
    'petersen': { lat: 14.6890, lng: -17.4380 },
    'sandaga': { lat: 14.6750, lng: -17.4300 },
    'tilene': { lat: 14.6800, lng: -17.4200 },
    'kermel': { lat: 14.6700, lng: -17.4350 },
    'marché sandaga': { lat: 14.6750, lng: -17.4300 },
    'marché kermel': { lat: 14.6700, lng: -17.4350 },
    'gare routière': { lat: 14.6780, lng: -17.4400 },
    'dieuppeul': { lat: 14.6900, lng: -17.4600 },
    'medina': { lat: 14.6738, lng: -17.4387 },
    'gueule tapée': { lat: 14.6800, lng: -17.4350 },
    'gueule tapee': { lat: 14.6800, lng: -17.4350 },
    
    // ====================================
    // ZONE 2: MEDINA / FASS (12 quartiers)
    // ====================================
    'fass': { lat: 14.6820, lng: -17.4500 },
    'fass delorme': { lat: 14.6850, lng: -17.4520 },
    'colobane': { lat: 14.6870, lng: -17.4550 },
    'gueule tapée fass colobane': { lat: 14.6830, lng: -17.4480 },
    'ndiolofene': { lat: 14.6760, lng: -17.4420 },
    'derklé': { lat: 14.6790, lng: -17.4460 },
    'derkle': { lat: 14.6790, lng: -17.4460 },
    'reubeuss': { lat: 14.6850, lng: -17.4450 },
    'somba gueladio': { lat: 14.6880, lng: -17.4380 },
    'scat urbam': { lat: 14.6810, lng: -17.4490 },
    'nim': { lat: 14.6795, lng: -17.4365 },
    'dalifort': { lat: 14.7200, lng: -17.4100 },
    
    // ====================================
    // ZONE 3: FANN / POINT E / MERMOZ (18 quartiers)
    // ====================================
    'fann': { lat: 14.6872, lng: -17.4535 },
    'fann résidence': { lat: 14.6890, lng: -17.4550 },
    'fann residence': { lat: 14.6890, lng: -17.4550 },
    'point e': { lat: 14.6953, lng: -17.4614 },
    'point-e': { lat: 14.6953, lng: -17.4614 },
    'amitié': { lat: 14.7014, lng: -17.4647 },
    'amitie': { lat: 14.7014, lng: -17.4647 },
    'sacré-coeur': { lat: 14.6937, lng: -17.4441 },
    'sacre-coeur': { lat: 14.6937, lng: -17.4441 },
    'sacre coeur': { lat: 14.6937, lng: -17.4441 },
    'mermoz': { lat: 14.7108, lng: -17.4682 },
    'pyrotechnie': { lat: 14.6920, lng: -17.4580 },
    'cité asecna': { lat: 14.7050, lng: -17.4700 },
    'cite asecna': { lat: 14.7050, lng: -17.4700 },
    'sicap baobabs': { lat: 14.7100, lng: -17.4650 },
    'keur gorgui': { lat: 14.7020, lng: -17.4620 },
    'fann bel air': { lat: 14.6900, lng: -17.4560 },
    'fann bel-air': { lat: 14.6900, lng: -17.4560 },
    'cité keur gorgui': { lat: 14.7020, lng: -17.4620 },
    'cite keur gorgui': { lat: 14.7020, lng: -17.4620 },
    
    // ====================================
    // ZONE 4: SICAP / HLM / GRAND YOFF (20 quartiers)
    // ====================================
    'sicap': { lat: 14.7289, lng: -17.4594 },
    'hlm': { lat: 14.7306, lng: -17.4542 },
    'hlm grand yoff': { lat: 14.7350, lng: -17.4600 },
    'hlm grand-yoff': { lat: 14.7350, lng: -17.4600 },
    'grand yoff': { lat: 14.7400, lng: -17.4700 },
    'grand-yoff': { lat: 14.7400, lng: -17.4700 },
    'village grand yoff': { lat: 14.7450, lng: -17.4750 },
    'arafat': { lat: 14.7380, lng: -17.4650 },
    'cité millionnaire': { lat: 14.7320, lng: -17.4570 },
    'cite millionnaire': { lat: 14.7320, lng: -17.4570 },
    'sipres': { lat: 14.7340, lng: -17.4610 },
    'sicap rue 10': { lat: 14.7270, lng: -17.4580 },
    'sicap amitié': { lat: 14.7280, lng: -17.4600 },
    'sicap amitie': { lat: 14.7280, lng: -17.4600 },
    'sicap baobab': { lat: 14.7290, lng: -17.4620 },
    'sicap mbao': { lat: 14.7300, lng: -17.4560 },
    'sicap foire': { lat: 14.7250, lng: -17.4550 },
    'dieuppeul derklé': { lat: 14.7150, lng: -17.4650 },
    'dieuppeul derkle': { lat: 14.7150, lng: -17.4650 },
    'camp pénal': { lat: 14.7360, lng: -17.4580 },
    'camp penal': { lat: 14.7360, lng: -17.4580 },
    'castors': { lat: 14.7420, lng: -17.4720 },
    
    // ====================================
    // ZONE 5: PARCELLES ASSAINIES (15 quartiers)
    // ====================================
    'parcelles assainies': { lat: 14.7369, lng: -17.4731 },
    'parcelles': { lat: 14.7369, lng: -17.4731 },
    'unité 1': { lat: 14.7300, lng: -17.4650 },
    'unite 1': { lat: 14.7300, lng: -17.4650 },
    'unité 2': { lat: 14.7320, lng: -17.4680 },
    'unite 2': { lat: 14.7320, lng: -17.4680 },
    'unité 3': { lat: 14.7340, lng: -17.4710 },
    'unite 3': { lat: 14.7340, lng: -17.4710 },
    'unité 4': { lat: 14.7360, lng: -17.4740 },
    'unite 4': { lat: 14.7360, lng: -17.4740 },
    'unité 5': { lat: 14.7380, lng: -17.4770 },
    'unite 5': { lat: 14.7380, lng: -17.4770 },
    'unité 6': { lat: 14.7400, lng: -17.4800 },
    'unite 6': { lat: 14.7400, lng: -17.4800 },
    'unité 7': { lat: 14.7420, lng: -17.4830 },
    'unite 7': { lat: 14.7420, lng: -17.4830 },
    'unité 8': { lat: 14.7440, lng: -17.4860 },
    'unite 8': { lat: 14.7440, lng: -17.4860 },
    'unité 9': { lat: 14.7460, lng: -17.4890 },
    'unite 9': { lat: 14.7460, lng: -17.4890 },
    'unité 10': { lat: 14.7480, lng: -17.4920 },
    'unite 10': { lat: 14.7480, lng: -17.4920 },
    'cambérène': { lat: 14.7500, lng: -17.4950 },
    'camberene': { lat: 14.7500, lng: -17.4950 },
    'apecsy': { lat: 14.7350, lng: -17.4760 },
    'apix': { lat: 14.7370, lng: -17.4780 },
    
    // ====================================
    // ZONE 6: OUEST (ALMADIES/NGOR/YOFF/OUAKAM) (18 quartiers)
    // ====================================
    'almadies': { lat: 14.7247, lng: -17.5050 },
    'les almadies': { lat: 14.7247, lng: -17.5050 },
    'pointe des almadies': { lat: 14.7200, lng: -17.5300 },
    'ngor': { lat: 14.7517, lng: -17.5192 },
    'virage ngor': { lat: 14.7500, lng: -17.5150 },
    'village ngor': { lat: 14.7550, lng: -17.5250 },
    'ile de ngor': { lat: 14.7600, lng: -17.5350 },
    'yoff': { lat: 14.7500, lng: -17.4833 },
    'village yoff': { lat: 14.7550, lng: -17.4900 },
    'tonghor': { lat: 14.7530, lng: -17.4850 },
    'aeroport yoff': { lat: 14.7400, lng: -17.4900 },
    'aéroport yoff': { lat: 14.7400, lng: -17.4900 },
    'ouakam': { lat: 14.7200, lng: -17.4900 },
    'cité des eaux': { lat: 14.7150, lng: -17.4950 },
    'cite des eaux': { lat: 14.7150, lng: -17.4950 },
    'mamelles': { lat: 14.7100, lng: -17.5000 },
    'les mamelles': { lat: 14.7100, lng: -17.5000 },
    'virage': { lat: 14.7314, lng: -17.4636 },
    'cité sonatel': { lat: 14.7250, lng: -17.4850 },
    'cite sonatel': { lat: 14.7250, lng: -17.4850 },
    
    // ====================================
    // ZONE 7: LIBERTÉ / GRAND DAKAR / HANN (16 quartiers)
    // ====================================
    'liberté': { lat: 14.7186, lng: -17.4697 },
    'liberte': { lat: 14.7186, lng: -17.4697 },
    'liberté 1': { lat: 14.7150, lng: -17.4650 },
    'liberte 1': { lat: 14.7150, lng: -17.4650 },
    'liberté 2': { lat: 14.7170, lng: -17.4680 },
    'liberte 2': { lat: 14.7170, lng: -17.4680 },
    'liberté 3': { lat: 14.7190, lng: -17.4710 },
    'liberte 3': { lat: 14.7190, lng: -17.4710 },
    'liberté 4': { lat: 14.7210, lng: -17.4740 },
    'liberte 4': { lat: 14.7210, lng: -17.4740 },
    'liberté 5': { lat: 14.7230, lng: -17.4770 },
    'liberte 5': { lat: 14.7230, lng: -17.4770 },
    'liberté 6': { lat: 14.7250, lng: -17.4800 },
    'liberte 6': { lat: 14.7250, lng: -17.4800 },
    'grand dakar': { lat: 14.6928, lng: -17.4580 },
    'grand-dakar': { lat: 14.6928, lng: -17.4580 },
    'hann': { lat: 14.7150, lng: -17.4380 },
    'bel air': { lat: 14.7100, lng: -17.4400 },
    'bel-air': { lat: 14.7100, lng: -17.4400 },
    'halte de hann': { lat: 14.7150, lng: -17.4380 },
    'marché hann': { lat: 14.7130, lng: -17.4350 },
    'marche hann': { lat: 14.7130, lng: -17.4350 },
    'hann bel air': { lat: 14.7120, lng: -17.4390 },
    'hann bel-air': { lat: 14.7120, lng: -17.4390 },
    'hann maristes': { lat: 14.7140, lng: -17.4360 },
    'patte d\'oie': { lat: 14.7200, lng: -17.4500 },
    'patte d\'oie builders': { lat: 14.7220, lng: -17.4520 },
    
    // ====================================
    // ZONE 8: PIKINE (10 quartiers)
    // ====================================
    'pikine': { lat: 14.7549, lng: -17.3940 },
    'pikine nord': { lat: 14.7600, lng: -17.3950 },
    'pikine est': { lat: 14.7550, lng: -17.3850 },
    'pikine ouest': { lat: 14.7500, lng: -17.4000 },
    'pikine sud': { lat: 14.7480, lng: -17.3900 },
    'thiaroye': { lat: 14.7730, lng: -17.3610 },
    'thiaroye sur mer': { lat: 14.7750, lng: -17.3550 },
    'diamaguène': { lat: 14.7600, lng: -17.3800 },
    'diamaguene': { lat: 14.7600, lng: -17.3800 },
    'icotaf': { lat: 14.7650, lng: -17.3700 },
    'guinaw rail': { lat: 14.7520, lng: -17.3880 },
    
    // ====================================
    // ZONE 9: GUÉDIAWAYE (10 quartiers)
    // ====================================
    'guédiawaye': { lat: 14.7690, lng: -17.3990 },
    'guediawaye': { lat: 14.7690, lng: -17.3990 },
    'sam notaire': { lat: 14.7700, lng: -17.4100 },
    'sam': { lat: 14.7700, lng: -17.4100 },
    'ndiarème limamoulaye': { lat: 14.7720, lng: -17.4050 },
    'ndiarem limamoulaye': { lat: 14.7720, lng: -17.4050 },
    'golf sud': { lat: 14.7750, lng: -17.4200 },
    'hamo': { lat: 14.7770, lng: -17.4150 },
    'médina gounass': { lat: 14.7680, lng: -17.3950 },
    'medina gounass': { lat: 14.7680, lng: -17.3950 },
    'wakhinane': { lat: 14.7730, lng: -17.4000 },
    'golf': { lat: 14.7750, lng: -17.4200 },
    'ndiarème': { lat: 14.7720, lng: -17.4050 },
    'ndiarem': { lat: 14.7720, lng: -17.4050 },
    
    // ====================================
    // ZONE 10: KEUR MASSAR (45+ quartiers)
    // ====================================
    
    // Zone Centrale
    'keur massar': { lat: 14.7833, lng: -17.3167 },
    'keurmassar': { lat: 14.7833, lng: -17.3167 },
    'keur massar centre': { lat: 14.7833, lng: -17.3167 },
    'keur massar ville': { lat: 14.7850, lng: -17.3150 },
    'keur massar marché': { lat: 14.7820, lng: -17.3180 },
    'keur massar marche': { lat: 14.7820, lng: -17.3180 },
    
    // Boune
    'boune': { lat: 14.7950, lng: -17.3250 },
    'boune 1': { lat: 14.7960, lng: -17.3240 },
    'boune 2': { lat: 14.7970, lng: -17.3260 },
    'boune 3': { lat: 14.7980, lng: -17.3280 },
    'boune cité darou salam': { lat: 14.7940, lng: -17.3230 },
    'boune cite darou salam': { lat: 14.7940, lng: -17.3230 },
    'boune extension': { lat: 14.8000, lng: -17.3270 },
    
    // Tivaouane Peulh
    'tivaouane peulh': { lat: 14.8050, lng: -17.3300 },
    'tivaouane peul': { lat: 14.8050, lng: -17.3300 },
    'tivaoune peul': { lat: 14.8050, lng: -17.3300 },
    'tivaouane peulh niaga': { lat: 14.8070, lng: -17.3280 },
    'tivaouane peulh comico': { lat: 14.8060, lng: -17.3320 },
    'tivaouane peulh 1': { lat: 14.8040, lng: -17.3290 },
    'tivaouane peulh 2': { lat: 14.8080, lng: -17.3310 },
    'tivaouane diacksao': { lat: 14.8100, lng: -17.3350 },
    'tivaouane peulh baraque': { lat: 14.8120, lng: -17.3370 },
    
    // Jaxaay
    'jaxaay': { lat: 14.7800, lng: -17.2950 },
    'djaxaay': { lat: 14.7800, lng: -17.2950 },
    'jaxaye': { lat: 14.7800, lng: -17.2950 },
    'jaxaay parcelles': { lat: 14.7820, lng: -17.2920 },
    'jaxaay deggo': { lat: 14.7790, lng: -17.2970 },
    'jaxaay bambilor': { lat: 14.7780, lng: -17.2900 },
    'bambilor': { lat: 14.7780, lng: -17.2900 },
    'jaxaay extension': { lat: 14.7840, lng: -17.2940 },
    
    // Yeumbeul
    'yeumbeul': { lat: 14.7720, lng: -17.3420 },
    'yembeul': { lat: 14.7720, lng: -17.3420 },
    'yeumbeul nord': { lat: 14.7750, lng: -17.3400 },
    'yeumbeul sud': { lat: 14.7700, lng: -17.3450 },
    'yeumbeul centre': { lat: 14.7720, lng: -17.3420 },
    'yeumbeul comico': { lat: 14.7740, lng: -17.3440 },
    'yeumbeul soprim': { lat: 14.7760, lng: -17.3380 },
    'arafat yeumbeul': { lat: 14.7730, lng: -17.3460 },
    
    // Malika
    'malika': { lat: 14.7800, lng: -17.3600 },
    'malika centre': { lat: 14.7800, lng: -17.3600 },
    'malika plateau': { lat: 14.7820, lng: -17.3620 },
    'malika gare': { lat: 14.7780, lng: -17.3580 },
    'malika stade': { lat: 14.7810, lng: -17.3640 },
    
    // Mbeubeuss
    'mbeubeuss': { lat: 14.7750, lng: -17.3000 },
    'mbeubeus': { lat: 14.7750, lng: -17.3000 },
    'mbeubeuss centre': { lat: 14.7750, lng: -17.3000 },
    'mbeubeuss extension': { lat: 14.7770, lng: -17.2980 },
    'mbeubeuss décharge': { lat: 14.7730, lng: -17.3020 },
    'mbeubeuss decharge': { lat: 14.7730, lng: -17.3020 },
    
    // Ndiaganiao
    'ndiaganiao': { lat: 14.7900, lng: -17.3050 },
    'ndiagagnao': { lat: 14.7900, lng: -17.3050 },
    'ndiaganiao centre': { lat: 14.7900, lng: -17.3050 },
    'ndiaganiao extension': { lat: 14.7920, lng: -17.3030 },
    
    // Cités et Lotissements
    'cité keur damel': { lat: 14.7860, lng: -17.3200 },
    'cite keur damel': { lat: 14.7860, lng: -17.3200 },
    'cité keur mandione': { lat: 14.7880, lng: -17.3220 },
    'cite keur mandione': { lat: 14.7880, lng: -17.3220 },
    'cité mbaye dione': { lat: 14.7870, lng: -17.3180 },
    'cite mbaye dione': { lat: 14.7870, lng: -17.3180 },
    'cité serigne mbaye sy': { lat: 14.7840, lng: -17.3140 },
    'cite serigne mbaye sy': { lat: 14.7840, lng: -17.3140 },
    
    // Zones Connexes
    'diamaguène sicap mbao': { lat: 14.7650, lng: -17.3100 },
    'diamaguene sicap mbao': { lat: 14.7650, lng: -17.3100 },
    'mbao': { lat: 14.7300, lng: -17.3200 },
    
    // ====================================
    // ZONES PÉRIPHÉRIQUES
    // ====================================
    'rufisque': { lat: 14.7167, lng: -17.2667 },
    'bargny': { lat: 14.7000, lng: -17.2167 },
    'sangalkam': { lat: 14.8000, lng: -17.2500 }
  };
  
  const addressLower = address.toLowerCase();
  
  // Recherche exacte
  for (const [quartier, coordonnees] of Object.entries(coords)) {
    if (addressLower.includes(quartier)) {
      console.log(`✅ Quartier: "${quartier}" → [${coordonnees.lat}, ${coordonnees.lng}]`);
      return coordonnees;
    }
  }
  
  // Fallback
  console.warn(`⚠️ Adresse non reconnue: "${address}" - Utilisation Plateau par défaut`);
  return { lat: 14.6928, lng: -17.4467 };
}

// Export pour utilisation dans d'autres modules
module.exports = { getDefaultCoordsForAddress };
