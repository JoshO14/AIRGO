// ═══════════════════════════════════════════════════════════════
//  NOTIFICATION SERVICE  –  Firebase FCM Push Notifications
// ═══════════════════════════════════════════════════════════════
'use strict';
const admin  = require('firebase-admin');
const { query } = require('../config/database');
const { v4: uuid } = require('uuid');
const logger = require('../utils/logger');

let firebaseApp;

function getFirebase() {
  if (firebaseApp) return firebaseApp;
  try {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL
      })
    });
    logger.info('✅  Firebase initialized');
  } catch (e) {
    logger.warn('Firebase not configured — push notifications disabled:', e.message);
  }
  return firebaseApp;
}

// ── Send single push notification ─────────────────────────────
async function send(fcmToken, { title, body, data = {} }) {
  const app = getFirebase();
  if (!app || !fcmToken) return;
  try {
    await admin.messaging().send({
      token:        fcmToken,
      notification: { title, body },
      data:         Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android:      { priority: 'high', notification: { sound: 'default', channel_id: 'airgo_rides' } },
      apns:         { payload: { aps: { sound: 'default', badge: 1 } } }
    });
    logger.debug(`FCM sent to ${fcmToken.slice(0,20)}…`);
  } catch (err) {
    logger.warn(`FCM send failed: ${err.message}`);
  }
}

// ── Send to multiple tokens ────────────────────────────────────
async function sendMulti(fcmTokens, notification) {
  await Promise.allSettled(fcmTokens.filter(Boolean).map(t => send(t, notification)));
}

// ── Save notification to DB and send push ─────────────────────
async function notify(userId, type, title, body, data = {}, fcmToken) {
  try {
    await query(
      `INSERT INTO notifications (id, user_id, type, title, body, data)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuid(), userId, type, title, body, JSON.stringify(data)]
    );

    if (fcmToken) await send(fcmToken, { title, body, data });
  } catch (err) {
    logger.error(`Notification save failed: ${err.message}`);
  }
}

// ── Notify all passengers in a trip ───────────────────────────
async function notifyTrip(tripId, notification) {
  const { rows } = await query(
    `SELECT u.id, u.fcm_token FROM bookings b JOIN users u ON u.id = b.user_id
     WHERE b.trip_id = $1 AND b.status = 'confirmed'`, [tripId]
  );
  for (const user of rows) {
    await notify(user.id, notification.type, notification.title, notification.body,
                 notification.data, user.fcm_token);
  }
}

module.exports = { send, sendMulti, notify, notifyTrip };


// ═══════════════════════════════════════════════════════════════
//  SMS SERVICE  –  Twilio
// ═══════════════════════════════════════════════════════════════
// Save this block separately as: src/services/smsService.js
