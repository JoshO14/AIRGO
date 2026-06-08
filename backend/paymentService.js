'use strict';
const axios  = require('axios');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { query, withTransaction } = require('../config/database');
const notifService = require('./notificationService');
const logger       = require('../utils/logger');

const PAYSTACK_BASE = 'https://api.paystack.co';
const HEADERS = {
  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
  'Content-Type': 'application/json'
};

// ── Initiate Payment ───────────────────────────────────────────
async function initiatePayment({ bookingId, userId, email, amountKobo, metadata }) {
  try {
    const ref = `AIRGO-${bookingId.slice(0, 8).toUpperCase()}-${Date.now()}`;

    const { data } = await axios.post(`${PAYSTACK_BASE}/transaction/initialize`, {
      email:     email || `user+${userId.slice(0,8)}@airgo.ng`,
      amount:    amountKobo,
      reference: ref,
      currency:  'NGN',
      metadata:  { ...metadata, booking_id: bookingId, custom_fields: [
        { display_name: 'Booking ID', variable_name: 'booking_id', value: bookingId }
      ]},
      callback_url: `${process.env.FRONTEND_URL}/payment/callback?ref=${ref}`
    }, { headers: HEADERS });

    // Save payment record
    await query(
      `INSERT INTO payments (id, booking_id, user_id, amount_kobo, method, status, provider_ref)
       VALUES ($1,$2,$3,$4,'paystack','pending',$5)`,
      [uuid(), bookingId, userId, amountKobo, ref]
    );

    await query(`UPDATE bookings SET paystack_ref = $1 WHERE id = $2`, [ref, bookingId]);

    logger.info(`Payment initiated: ${ref} for booking ${bookingId}`);
    return data.data.authorization_url;
  } catch (err) {
    logger.error(`Payment initiation failed: ${err.message}`);
    throw err;
  }
}

// ── Verify Payment (Webhook / callback) ───────────────────────
async function verifyPayment(reference) {
  const { data } = await axios.get(
    `${PAYSTACK_BASE}/transaction/verify/${reference}`, { headers: HEADERS }
  );
  return data.data;
}

// ── Handle Paystack Webhook ────────────────────────────────────
async function handleWebhook(rawBody, signature) {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  if (hash !== signature) {
    throw Object.assign(new Error('Invalid webhook signature'), { status: 401 });
  }

  const event = JSON.parse(rawBody);
  logger.info(`Paystack webhook: ${event.event}`);

  switch (event.event) {
    case 'charge.success':
      await handleChargeSuccess(event.data);
      break;
    case 'transfer.success':
      await handleTransferSuccess(event.data);
      break;
    case 'transfer.failed':
    case 'transfer.reversed':
      await handleTransferFailed(event.data);
      break;
    case 'refund.processed':
      await handleRefundProcessed(event.data);
      break;
    default:
      logger.debug(`Unhandled Paystack event: ${event.event}`);
  }
}

async function handleChargeSuccess(data) {
  const { reference, metadata } = data;
  const bookingId = metadata?.booking_id;
  if (!bookingId) return;

  await withTransaction(async (client) => {
    // Update payment record
    await client.query(
      `UPDATE payments SET status = 'success', completed_at = NOW(), provider_data = $1
       WHERE provider_ref = $2`,
      [JSON.stringify(data), reference]
    );

    // Update booking status
    await client.query(
      `UPDATE bookings SET status = 'confirmed', payment_status = 'success' WHERE id = $1`,
      [bookingId]
    );

    // Check if trip is now full → confirm trip
    const { rows: [booking] } = await client.query(`SELECT * FROM bookings WHERE id = $1`, [bookingId]);
    const { rows: [trip] } = await client.query(`SELECT * FROM trips WHERE id = $1`, [booking.trip_id]);

    if (trip && trip.seats_taken >= trip.seats_total) {
      await client.query(`UPDATE trips SET status = 'confirmed' WHERE id = $1`, [trip.id]);
    }

    // Notify passenger
    const { rows: [user] } = await client.query(
      `SELECT fcm_token, full_name FROM users WHERE id = $1`, [booking.user_id]
    );
    if (user?.fcm_token) {
      await notifService.send(user.fcm_token, {
        title: '✅ Booking Confirmed!',
        body:  `Payment received. Your seat to ${trip?.airport_code} is secured.`,
        data:  { type: 'ride_confirmed', booking_id: bookingId, trip_id: booking.trip_id }
      });
    }

    // Notify organizer
    const { rows: [organizer] } = await client.query(
      `SELECT fcm_token, full_name FROM users WHERE id = $1`, [trip?.organizer_id]
    );
    if (organizer?.fcm_token) {
      await notifService.send(organizer.fcm_token, {
        title: '👤 New passenger joined!',
        body:  `${user?.full_name} joined your trip to ${trip?.airport_code}.`,
        data:  { type: 'passenger_joined', trip_id: booking.trip_id }
      });
    }
  });

  logger.info(`Payment confirmed for booking ${bookingId}`);
}

async function handleTransferSuccess(data) {
  await query(
    `UPDATE driver_payouts SET status = 'success', completed_at = NOW() WHERE paystack_ref = $1`,
    [data.reference]
  );
  logger.info(`Driver payout confirmed: ${data.reference}`);
}

async function handleTransferFailed(data) {
  await query(
    `UPDATE driver_payouts SET status = 'failed' WHERE paystack_ref = $1`, [data.reference]
  );
  logger.warn(`Driver payout failed: ${data.reference}`);
}

async function handleRefundProcessed(data) {
  await query(
    `UPDATE bookings SET payment_status = 'refunded', status = 'refunded' WHERE paystack_ref = $1`,
    [data.transaction_reference]
  );
}

// ── Initiate Refund ────────────────────────────────────────────
async function initiateRefund(bookingId, amountKobo) {
  try {
    const { rows: [booking] } = await query(
      `SELECT paystack_ref FROM bookings WHERE id = $1`, [bookingId]
    );
    if (!booking?.paystack_ref) throw new Error('No payment reference found');

    const { data } = await axios.post(`${PAYSTACK_BASE}/refund`, {
      transaction: booking.paystack_ref,
      amount:      amountKobo
    }, { headers: HEADERS });

    await query(
      `UPDATE bookings SET status = 'refunded', refund_ref = $1 WHERE id = $2`,
      [data.data.id, bookingId]
    );

    logger.info(`Refund initiated for booking ${bookingId}: ${data.data.id}`);
    return data.data;
  } catch (err) {
    logger.error(`Refund failed for booking ${bookingId}: ${err.message}`);
    throw err;
  }
}

// ── Pay Driver ─────────────────────────────────────────────────
async function payDriver(tripId) {
  const { rows: [trip] } = await query(
    `SELECT t.*, d.bank_account, d.full_name AS driver_name
     FROM trips t JOIN drivers d ON d.id = t.driver_id WHERE t.id = $1`, [tripId]
  );
  if (!trip?.driver_id) throw new Error('No driver on this trip');

  const totalCollected = trip.total_fare || 0;
  const airgoFee = Math.round(totalCollected * (trip.service_fee_rate / 100));
  const driverNet = totalCollected - airgoFee;

  const bankAccount = trip.bank_account;
  if (!bankAccount?.account_number || !bankAccount?.bank_code) {
    throw new Error('Driver bank account not configured');
  }

  const ref = `PAYOUT-${tripId.slice(0,8)}-${Date.now()}`;

  // Create transfer recipient if not exists
  const { data: recipientData } = await axios.post(`${PAYSTACK_BASE}/transferrecipient`, {
    type:           'nuban',
    name:           trip.driver_name,
    account_number: bankAccount.account_number,
    bank_code:      bankAccount.bank_code,
    currency:       'NGN'
  }, { headers: HEADERS });

  const recipientCode = recipientData.data.recipient_code;

  // Initiate transfer
  const { data: transferData } = await axios.post(`${PAYSTACK_BASE}/transfer`, {
    source:    'balance',
    amount:    driverNet,
    recipient: recipientCode,
    reason:    `Airgo trip ${tripId.slice(0,8)} payout`,
    reference: ref
  }, { headers: HEADERS });

  await query(
    `INSERT INTO driver_payouts (id, driver_id, trip_id, amount_kobo, airgo_fee_kobo, net_kobo, status, paystack_ref, bank_account)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)`,
    [uuid(), trip.driver_id, tripId, totalCollected, airgoFee, driverNet, ref, JSON.stringify(bankAccount)]
  );

  logger.info(`Driver payout initiated: ₦${driverNet/100} for trip ${tripId}`);
  return transferData.data;
}

module.exports = { initiatePayment, verifyPayment, handleWebhook, initiateRefund, payDriver };
