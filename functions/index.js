// =================================================
// FICHIER TEST MINIMAL - FONCTIONS DE CRÉDIT UNIQUEMENT
// Utilisez ce fichier pour tester le déploiement
// =================================================

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

// Configuration
const PAYMENT_CONFIG = {
    driverRate: 0.70,
    platformRate: 0.30
};

// Fonction utilitaire
function parseMoney(value) {
    if (value === undefined || value === null) return 0;
    const cleanStr = String(value).replace(/[^0-9.-]+/g, ""); 
    const num = parseFloat(cleanStr);
    return isNaN(num) ? 0 : num;
}

// =================================================
// FONCTION 1 : Crédit automatique
// =================================================
exports.crediterChauffeurAutomatique = functions.firestore
    .document('reservations/{reservationId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        const reservationId = context.params.reservationId;
        
        // Vérifications
        if (before.paiementValide === true || after.paiementValide !== true) {
            return null;
        }
        
        console.log(`💰 [CRÉDIT AUTO] Paiement détecté: ${reservationId}`);
        
        if (after.statut !== 'terminee') {
            console.log(`⏭️ Course pas terminée: ${after.statut}`);
            return null;
        }
        
        if (after.chauffeurCredite === true) {
            console.log(`⏭️ Déjà crédité`);
            return null;
        }
        
        if (!after.chauffeurAssigne) {
            console.log(`❌ Pas de chauffeur`);
            return null;
        }
        
        const driverId = after.chauffeurAssigne;
        const prixEstime = parseMoney(after.prixEstime);
        
        if (prixEstime <= 0) {
            console.log(`❌ Prix invalide: ${prixEstime}`);
            return null;
        }
        
        const netAmount = Math.round(prixEstime * PAYMENT_CONFIG.driverRate);
        const platformAmount = prixEstime - netAmount;
        
        console.log(`💵 Montant: ${netAmount} FCFA`);
        
        try {
            await db.runTransaction(async (transaction) => {
                const reservationRef = db.collection('reservations').doc(reservationId);
                const reservationDoc = await transaction.get(reservationRef);
                
                if (!reservationDoc.exists) {
                    throw new Error('RESERVATION_NOT_FOUND');
                }
                
                const reservationData = reservationDoc.data();
                
                if (reservationData.statut !== 'terminee') {
                    throw new Error('COURSE_NOT_COMPLETED');
                }
                
                if (reservationData.chauffeurCredite === true) {
                    throw new Error('ALREADY_CREDITED');
                }
                
                if (reservationData.paiementValide !== true) {
                    throw new Error('PAYMENT_NOT_VALIDATED');
                }
                
                if (reservationData.chauffeurAssigne !== driverId) {
                    throw new Error('WRONG_DRIVER');
                }
                
                const driverRef = db.collection('drivers').doc(driverId);
                const driverDoc = await transaction.get(driverRef);
                
                if (!driverDoc.exists) {
                    throw new Error('DRIVER_NOT_FOUND');
                }
                
                const driverData = driverDoc.data();
                const oldSolde = parseMoney(driverData.soldeDisponible || driverData.SoldeDisponible);
                const newSolde = oldSolde + netAmount;
                
                console.log(`📊 Nouveau solde: ${newSolde} FCFA`);
                
                transaction.update(driverRef, {
                    soldeDisponible: newSolde,
                    revenusTotal: admin.firestore.FieldValue.increment(netAmount),
                    dernierCredit: admin.firestore.FieldValue.serverTimestamp()
                });
                
                transaction.update(reservationRef, {
                    chauffeurCredite: true,
                    dateCreditChauffeur: admin.firestore.FieldValue.serverTimestamp(),
                    montantCrediteChauffeur: netAmount,
                    montantPlateforme: platformAmount,
                    creditVersion: 'cloud-function-v1.0'
                });
                
                console.log(`✅ Transaction préparée`);
            });
            
            console.log(`✅ Crédit réussi: ${netAmount} FCFA`);
            
            await db.collection('notifications').add({
                chauffeurId: driverId,
                type: 'credit_recu',
                reservationId: reservationId,
                montant: netAmount,
                message: `Vous avez reçu ${netAmount} FCFA`,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                lu: false
            });
            
            await db.collection('credit_logs').add({
                reservationId: reservationId,
                chauffeurId: driverId,
                montantCourse: prixEstime,
                montantChauffeur: netAmount,
                montantPlateforme: platformAmount,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                success: true
            });
            
            return null;
            
        } catch (error) {
            console.error(`❌ Erreur: ${error.message}`);
            
            await db.collection('credit_errors').add({
                reservationId: reservationId,
                chauffeurId: driverId,
                errorMessage: error.message,
                errorStack: error.stack,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            return null;
        }
    });

// =================================================
// FONCTION 2 : Récupération manuelle
// =================================================
exports.recupererCreditsManques = functions.https.onCall(async (data, context) => {
    if (!context.auth && !data.adminToken) {
        throw new functions.https.HttpsError('unauthenticated', 'Non authentifié');
    }
    
    console.log('🔧 [RÉCUP] Recherche...');
    
    try {
        const snapshot = await db.collection('reservations')
            .where('statut', '==', 'terminee')
            .where('paiementValide', '==', true)
            .where('chauffeurCredite', '==', false)
            .get();
        
        if (snapshot.empty) {
            return {
                success: true,
                message: 'Aucun crédit manqué',
                count: 0
            };
        }
        
        console.log(`🔍 ${snapshot.size} crédits manqués`);
        
        const results = [];
        
        for (const doc of snapshot.docs) {
            const reservationId = doc.id;
            const reservation = doc.data();
            
            try {
                const driverId = reservation.chauffeurAssigne;
                const prixEstime = parseMoney(reservation.prixEstime);
                const netAmount = Math.round(prixEstime * PAYMENT_CONFIG.driverRate);
                const platformAmount = prixEstime - netAmount;
                
                await db.runTransaction(async (transaction) => {
                    const driverRef = db.collection('drivers').doc(driverId);
                    const driverDoc = await transaction.get(driverRef);
                    
                    if (!driverDoc.exists) {
                        throw new Error('Driver not found');
                    }
                    
                    const driverData = driverDoc.data();
                    const oldSolde = parseMoney(driverData.soldeDisponible || driverData.SoldeDisponible);
                    const newSolde = oldSolde + netAmount;
                    
                    transaction.update(driverRef, {
                        soldeDisponible: newSolde,
                        revenusTotal: admin.firestore.FieldValue.increment(netAmount)
                    });
                    
                    transaction.update(doc.ref, {
                        chauffeurCredite: true,
                        dateCreditChauffeur: admin.firestore.FieldValue.serverTimestamp(),
                        montantCrediteChauffeur: netAmount,
                        montantPlateforme: platformAmount,
                        creditVersion: 'recovery-manual'
                    });
                });
                
                results.push({
                    reservationId: reservationId,
                    success: true,
                    montant: netAmount
                });
                
                console.log(`✅ ${reservationId}: ${netAmount} FCFA`);
                
            } catch (error) {
                results.push({
                    reservationId: reservationId,
                    success: false,
                    error: error.message
                });
                
                console.error(`❌ ${reservationId}: ${error.message}`);
            }
        }
        
        const successCount = results.filter(r => r.success).length;
        
        return {
            success: true,
            message: `${successCount}/${results.length} crédits récupérés`,
            count: successCount,
            details: results
        };
        
    } catch (error) {
        console.error('❌ Erreur:', error);
        throw new functions.https.HttpsError('internal', error.message);
    }
});

// =================================================
// FIN DU FICHIER TEST
// =================================================
