const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

// ==========================================
// CONFIGURATION TRACKING
// ==========================================
const TRACKING_CONFIG = {
    maxInactivityMinutes: 10,      // Temps max sans mise à jour GPS
    geofenceRadius: 100,            // Rayon de géofence en mètres
    speedThreshold: 120,            // Vitesse max acceptée (km/h)
    accuracyThreshold: 50,          // Précision GPS max acceptée (m)
    batchUpdateInterval: 5,         // Intervalle de batch en secondes
};

// ==========================================
// 1. MONITORING DES POSITIONS EN TEMPS RÉEL
// ==========================================

/**
 * Trigger sur les mises à jour de position des chauffeurs
 */
exports.onDriverPositionUpdate = functions.firestore
    .document('drivers/{driverId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();
        const driverId = context.params.driverId;

        // Vérifier si la position a changé
        if (!after.position || !before.position) return null;

        const oldPos = before.position;
        const newPos = after.position;

        // Si pas de changement significatif, ignorer
        if (oldPos.latitude === newPos.latitude && 
            oldPos.longitude === newPos.longitude) {
            return null;
        }

        console.log(`📍 Position mise à jour: ${driverId}`);

        try {
            // Calculer la distance parcourue
            const distance = calculerDistance(
                oldPos.latitude,
                oldPos.longitude,
                newPos.latitude,
                newPos.longitude
            );

            // Calculer la vitesse
            const timeDiff = (newPos.timestamp?.toMillis() || Date.now()) - 
                            (oldPos.timestamp?.toMillis() || Date.now() - 3000);
            const vitesse = (distance / (timeDiff / 1000)) * 3.6; // km/h

            // Vérifications de cohérence
            const anomalies = [];

            if (vitesse > TRACKING_CONFIG.speedThreshold) {
                anomalies.push(`Vitesse excessive: ${vitesse.toFixed(0)} km/h`);
            }

            if (newPos.accuracy > TRACKING_CONFIG.accuracyThreshold) {
                anomalies.push(`Précision GPS faible: ${newPos.accuracy}m`);
            }

            // Logger les anomalies
            if (anomalies.length > 0) {
                await db.collection('tracking_anomalies').add({
                    driverId: driverId,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    anomalies: anomalies,
                    position: newPos,
                    calculatedSpeed: vitesse
                });
            }

            // Mettre à jour les statistiques
            await db.collection('driver_stats').doc(driverId).set({
                lastPosition: newPos,
                lastUpdate: admin.firestore.FieldValue.serverTimestamp(),
                calculatedSpeed: vitesse,
                totalDistanceToday: admin.firestore.FieldValue.increment(distance)
            }, { merge: true });

            // Si le chauffeur est en course, mettre à jour les détails de la course
            if (after.currentBookingId) {
                await updateCourseTracking(after.currentBookingId, newPos, distance);
            }

        } catch (error) {
            console.error('❌ Erreur traitement position:', error);
        }

        return null;
    });

/**
 * Met à jour le tracking d'une course active
 */
async function updateCourseTracking(courseId, position, distanceIncrement) {
    try {
        const courseRef = db.collection('reservations').doc(courseId);
        const courseDoc = await courseRef.get();

        if (!courseDoc.exists) return;

        const course = courseDoc.data();

        // Calculer l'ETA si on a une destination
        let eta = null;
        if (course.destinationCoords && position) {
            const distanceRestante = calculerDistance(
                position.latitude,
                position.longitude,
                course.destinationCoords.lat,
                course.destinationCoords.lng
            );

            const vitesseMoyenne = position.speed ? position.speed * 3.6 : 40; // km/h
            const tempsRestant = (distanceRestante / vitesseMoyenne) * 60; // minutes

            eta = new Date(Date.now() + tempsRestant * 60000);
        }

        // Mettre à jour
        await courseRef.update({
            chauffeurPosition: position,
            lastTrackingUpdate: admin.firestore.FieldValue.serverTimestamp(),
            distanceReelleParcourue: admin.firestore.FieldValue.increment(distanceIncrement * 1000),
            estimatedArrival: eta
        });

        console.log(`✅ Course ${courseId} trackée`);

    } catch (error) {
        console.error('❌ Erreur update course tracking:', error);
    }
}

// ==========================================
// 2. DÉTECTION D'INACTIVITÉ
// ==========================================

/**
 * Détecte les chauffeurs inactifs (pas de mise à jour GPS)
 */
exports.detectInactiveDrivers = functions.pubsub
    .schedule('every 5 minutes')
    .onRun(async (context) => {
        console.log('🔍 Vérification chauffeurs inactifs...');

        const cutoffTime = new Date(Date.now() - TRACKING_CONFIG.maxInactivityMinutes * 60000);

        try {
            const snapshot = await db.collection('drivers')
                .where('statut', 'in', ['disponible', 'en_course'])
                .get();

            const inactiveDrivers = [];

            snapshot.forEach(doc => {
                const data = doc.data();
                const lastUpdate = data.derniereActivite?.toDate() || 
                                  data.position?.timestamp?.toDate();

                if (lastUpdate && lastUpdate < cutoffTime) {
                    inactiveDrivers.push({
                        id: doc.id,
                        nom: `${data.prenom} ${data.nom}`,
                        lastUpdate: lastUpdate,
                        statut: data.statut
                    });
                }
            });

            if (inactiveDrivers.length > 0) {
                console.log(`⚠️ ${inactiveDrivers.length} chauffeurs inactifs détectés`);

                // Créer une notification admin
                await db.collection('notifications_admin').add({
                    type: 'chauffeurs_inactifs',
                    count: inactiveDrivers.length,
                    drivers: inactiveDrivers,
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    lu: false
                });

                // Passer les chauffeurs en "hors ligne suspect"
                const batch = db.batch();
                inactiveDrivers.forEach(driver => {
                    batch.update(db.collection('drivers').doc(driver.id), {
                        statut: 'hors_ligne',
                        inactivityDetected: true,
                        lastInactivityCheck: admin.firestore.FieldValue.serverTimestamp()
                    });
                });
                await batch.commit();
            }

        } catch (error) {
            console.error('❌ Erreur détection inactivité:', error);
        }

        return null;
    });

// ==========================================
// 3. GÉOFENCING (ZONES D'ALERTE)
// ==========================================

/**
 * Vérifie si un chauffeur entre/sort de zones spécifiques
 */
exports.checkGeofences = functions.firestore
    .document('position_history/{positionId}')
    .onCreate(async (snap, context) => {
        const position = snap.data();
        const driverId = position.driverId;

        try {
            // Récupérer les zones de géofence
            const geofencesSnapshot = await db.collection('geofences')
                .where('active', '==', true)
                .get();

            if (geofencesSnapshot.empty) return null;

            const alerts = [];

            geofencesSnapshot.forEach(doc => {
                const zone = doc.data();
                const distance = calculerDistance(
                    position.position.latitude,
                    position.position.longitude,
                    zone.center.latitude,
                    zone.center.longitude
                );

                // Si dans la zone
                if (distance <= zone.radius / 1000) { // convertir m en km
                    alerts.push({
                        zoneId: doc.id,
                        zoneName: zone.name,
                        type: zone.type, // 'alert', 'restricted', 'pickup_zone'
                        distance: distance
                    });
                }
            });

            // Si des alertes, les créer
            if (alerts.length > 0) {
                await db.collection('geofence_events').add({
                    driverId: driverId,
                    position: position.position,
                    alerts: alerts,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });

                console.log(`🚨 ${alerts.length} alertes géofence pour ${driverId}`);
            }

        } catch (error) {
            console.error('❌ Erreur géofencing:', error);
        }

        return null;
    });

// ==========================================
// 4. STATISTIQUES DE TRACKING
// ==========================================

/**
 * Calcule les statistiques de tracking quotidiennes
 */
exports.calculateDailyTrackingStats = functions.pubsub
    .schedule('every day 00:01')
    .timeZone('Africa/Dakar')
    .onRun(async (context) => {
        console.log('📊 Calcul stats tracking quotidiennes...');

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);

        const today = new Date(yesterday);
        today.setDate(today.getDate() + 1);

        try {
            const driversSnapshot = await db.collection('drivers').get();

            const statsPromises = driversSnapshot.docs.map(async (driverDoc) => {
                const driverId = driverDoc.id;

                // Récupérer toutes les positions d'hier
                const positionsSnapshot = await db.collection('position_history')
                    .where('driverId', '==', driverId)
                    .where('timestamp', '>=', yesterday)
                    .where('timestamp', '<', today)
                    .orderBy('timestamp', 'asc')
                    .get();

                if (positionsSnapshot.empty) return null;

                let totalDistance = 0;
                let totalTime = 0;
                let maxSpeed = 0;
                let positionsCount = positionsSnapshot.size;

                const positions = [];
                positionsSnapshot.forEach(doc => positions.push(doc.data()));

                // Calculer les stats
                for (let i = 1; i < positions.length; i++) {
                    const prev = positions[i - 1];
                    const curr = positions[i];

                    const distance = calculerDistance(
                        prev.position.latitude,
                        prev.position.longitude,
                        curr.position.latitude,
                        curr.position.longitude
                    );

                    totalDistance += distance;

                    const speed = curr.speed || 0;
                    if (speed > maxSpeed) maxSpeed = speed;

                    const timeDiff = (curr.timestamp?.toMillis() || 0) - 
                                    (prev.timestamp?.toMillis() || 0);
                    totalTime += timeDiff;
                }

                // Sauvegarder les stats
                await db.collection('daily_tracking_stats').add({
                    driverId: driverId,
                    date: yesterday,
                    totalDistance: totalDistance, // km
                    totalTime: totalTime / 1000 / 60, // minutes
                    averageSpeed: totalDistance / (totalTime / 1000 / 3600), // km/h
                    maxSpeed: maxSpeed * 3.6, // km/h
                    positionsCount: positionsCount,
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });

                console.log(`✅ Stats calculées pour ${driverId}: ${totalDistance.toFixed(2)} km`);

                return {
                    driverId: driverId,
                    distance: totalDistance
                };
            });

            const results = await Promise.all(statsPromises);
            const validResults = results.filter(r => r !== null);

            console.log(`✅ Stats calculées pour ${validResults.length} chauffeurs`);

        } catch (error) {
            console.error('❌ Erreur calcul stats:', error);
        }

        return null;
    });

// ==========================================
// 5. NETTOYAGE DE L'HISTORIQUE
// ==========================================

/**
 * Nettoie l'historique des positions anciennes (>7 jours)
 */
exports.cleanupOldPositionHistory = functions.pubsub
    .schedule('every day 02:00')
    .timeZone('Africa/Dakar')
    .onRun(async (context) => {
        console.log('🧹 Nettoyage historique positions...');

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 7);

        try {
            let deletedCount = 0;
            let hasMore = true;

            while (hasMore) {
                const snapshot = await db.collection('position_history')
                    .where('timestamp', '<', cutoffDate)
                    .limit(500)
                    .get();

                if (snapshot.empty) {
                    hasMore = false;
                    break;
                }

                const batch = db.batch();
                snapshot.docs.forEach(doc => {
                    batch.delete(doc.ref);
                });

                await batch.commit();
                deletedCount += snapshot.size;

                console.log(`🗑️ ${deletedCount} positions supprimées...`);
            }

            console.log(`✅ Nettoyage terminé: ${deletedCount} positions supprimées`);

            // Logger le nettoyage
            await db.collection('system_logs').add({
                type: 'cleanup_position_history',
                deletedCount: deletedCount,
                cutoffDate: cutoffDate,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

        } catch (error) {
            console.error('❌ Erreur nettoyage:', error);
        }

        return null;
    });

// ==========================================
// 6. API POUR RÉCUPÉRER L'HISTORIQUE
// ==========================================

/**
 * Récupère l'historique de tracking d'un chauffeur
 */
exports.getDriverTrackingHistory = functions.https.onCall(async (data, context) => {
    const { driverId, startDate, endDate, sessionId } = data;

    if (!driverId) {
        throw new functions.https.HttpsError('invalid-argument', 'Driver ID requis');
    }

    try {
        let query = db.collection('position_history')
            .where('driverId', '==', driverId);

        if (sessionId) {
            query = query.where('sessionId', '==', sessionId);
        }

        if (startDate) {
            query = query.where('timestamp', '>=', new Date(startDate));
        }

        if (endDate) {
            query = query.where('timestamp', '<=', new Date(endDate));
        }

        query = query.orderBy('timestamp', 'asc').limit(1000);

        const snapshot = await query.get();

        const positions = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            positions.push({
                lat: data.position.latitude,
                lng: data.position.longitude,
                speed: data.speed,
                accuracy: data.accuracy,
                timestamp: data.timestamp?.toDate()
            });
        });

        return {
            success: true,
            count: positions.length,
            positions: positions
        };

    } catch (error) {
        console.error('❌ Erreur:', error);
        throw new functions.https.HttpsError('internal', error.message);
    }
});

/**
 * Récupère les statistiques de tracking d'un chauffeur
 */
exports.getDriverTrackingStats = functions.https.onCall(async (data, context) => {
    const { driverId, period } = data;

    if (!driverId) {
        throw new functions.https.HttpsError('invalid-argument', 'Driver ID requis');
    }

    try {
        const stats = {
            today: {},
            week: {},
            month: {},
            total: {}
        };

        // Stats aujourd'hui
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const todaySnapshot = await db.collection('position_history')
            .where('driverId', '==', driverId)
            .where('timestamp', '>=', today)
            .get();

        stats.today = await calculateStatsFromPositions(todaySnapshot);

        // Stats dernière semaine
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        weekAgo.setHours(0, 0, 0, 0);

        const weekSnapshot = await db.collection('daily_tracking_stats')
            .where('driverId', '==', driverId)
            .where('date', '>=', weekAgo)
            .get();

        stats.week = aggregateDailyStats(weekSnapshot);

        // Stats mois
        const monthAgo = new Date();
        monthAgo.setDate(monthAgo.getDate() - 30);
        monthAgo.setHours(0, 0, 0, 0);

        const monthSnapshot = await db.collection('daily_tracking_stats')
            .where('driverId', '==', driverId)
            .where('date', '>=', monthAgo)
            .get();

        stats.month = aggregateDailyStats(monthSnapshot);

        return {
            success: true,
            stats: stats
        };

    } catch (error) {
        console.error('❌ Erreur:', error);
        throw new functions.https.HttpsError('internal', error.message);
    }
});

// ==========================================
// FONCTIONS UTILITAIRES
// ==========================================

function calculerDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // Rayon de la Terre en km
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function toRad(value) {
    return value * Math.PI / 180;
}

async function calculateStatsFromPositions(snapshot) {
    if (snapshot.empty) {
        return {
            totalDistance: 0,
            averageSpeed: 0,
            maxSpeed: 0,
            positionsCount: 0
        };
    }

    let totalDistance = 0;
    let maxSpeed = 0;
    const positions = [];

    snapshot.forEach(doc => positions.push(doc.data()));

    for (let i = 1; i < positions.length; i++) {
        const prev = positions[i - 1];
        const curr = positions[i];

        const distance = calculerDistance(
            prev.position.latitude,
            prev.position.longitude,
            curr.position.latitude,
            curr.position.longitude
        );

        totalDistance += distance;

        const speed = (curr.speed || 0) * 3.6;
        if (speed > maxSpeed) maxSpeed = speed;
    }

    return {
        totalDistance: totalDistance,
        averageSpeed: positions.length > 0 ? 
            positions.reduce((sum, p) => sum + ((p.speed || 0) * 3.6), 0) / positions.length : 0,
        maxSpeed: maxSpeed,
        positionsCount: positions.length
    };
}

function aggregateDailyStats(snapshot) {
    if (snapshot.empty) {
        return {
            totalDistance: 0,
            averageSpeed: 0,
            maxSpeed: 0,
            totalTime: 0
        };
    }

    let totalDistance = 0;
    let totalTime = 0;
    let maxSpeed = 0;
    let speedSum = 0;
    let count = 0;

    snapshot.forEach(doc => {
        const data = doc.data();
        totalDistance += data.totalDistance || 0;
        totalTime += data.totalTime || 0;
        if ((data.maxSpeed || 0) > maxSpeed) maxSpeed = data.maxSpeed;
        speedSum += data.averageSpeed || 0;
        count++;
    });

    return {
        totalDistance: totalDistance,
        averageSpeed: count > 0 ? speedSum / count : 0,
        maxSpeed: maxSpeed,
        totalTime: totalTime
    };
}
