// ═══════════════════════════════════════════════════════════════
//  BOOKINGS ROUTER  –  src/routes/bookings.js
// ═══════════════════════════════════════════════════════════════
'use strict';
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { query, withTransaction } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const paymentService = require('../services/paymentService');
const notifService   = require('../services/notificationService');
const logger         = require('../utils/logger');

// ── POST /bookings – book a seat on a trip ─────────────────────
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { trip_id, pickup_address, pickup_lat, pickup_lng, payment_method, promo_code } = req.body;
    if (!trip_id || !pickup_address) {
      return res.status(400).json({ success: false, message: 'trip_id and pickup_address required' });
    }

    const result = await withTransaction(async (client) => {
      // Lock the trip row
      const { rows: [trip] } = await client.query(
        `SELECT * FROM trips WHERE id = $1 FOR UPDATE`, [trip_id]
      );
      if (!trip) throw Object.assign(new Error('Trip not found'), { status: 404 });
      if (trip.status !== 'matching') throw Object.assign(new Error(`Trip is ${trip.status}`), { status: 400 });
      if (trip.seats_taken >= trip.seats_total) throw Object.assign(new Error('No seats available'), { status: 400 });
      if (trip.organizer_id === req.user.id) throw Object.assign(new Error('You cannot book your own trip'), { status: 400 });

      // Check not already booked
      const { rows: existing } = await client.query(
        `SELECT id FROM bookings WHERE trip_id = $1 AND user_id = $2 AND status != 'cancelled'`,
        [trip_id, req.user.id]
      );
      if (existing.length) throw Object.assign(new Error('You already have a booking on this trip'), { status: 409 });

      // Calculate fare
      const pax     = trip.seats_total;
      const feeRate = req.user.is_premium ? 6 : 10;
      const fareEach  = Math.floor((trip.total_fare || 15000 * 100) / pax); // default ₦15,000 if not set
      const serviceFee = Math.round(fareEach * feeRate / 100);
      const totalCharge = fareEach + serviceFee;

      // Apply promo code if provided
      let discountKobo = 0;
      if (promo_code) {
        const { rows: [promo] } = await client.query(
          `SELECT * FROM promo_codes WHERE code = $1 AND is_active = TRUE
           AND (valid_until IS NULL OR valid_until > NOW())`, [promo_code.toUpperCase()]
        );
        if (promo) {
          discountKobo = promo.discount_type === 'percent'
            ? Math.round(totalCharge * promo.discount_value / 100)
            : promo.discount_value;
          await client.query(
            `INSERT INTO promo_uses (id, promo_id, user_id) VALUES ($1,$2,$3)`,
            [uuid(), promo.id, req.user.id]
          );
          await client.query(`UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1`, [promo.id]);
        }
      }

      const finalCharge = Math.max(0, totalCharge - discountKobo);

      // Create booking record
      const { rows: [booking] } = await client.query(
        `INSERT INTO bookings (id, trip_id, user_id, pickup_address, pickup_lat, pickup_lng,
           pickup_order, amount_kobo, service_fee_kobo, payment_method, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
         RETURNING *`,
        [uuid(), trip_id, req.user.id, pickup_address, pickup_lat || null, pickup_lng || null,
         trip.seats_taken + 1, finalCharge, serviceFee, payment_method || 'paystack']
      );

      // Increment seats_taken
      await client.query(
        `UPDATE trips SET seats_taken = seats_taken + 1 WHERE id = $1`, [trip_id]
      );

      return { booking, trip, finalCharge };
    });

    // Initiate Paystack payment
    const paymentUrl = await paymentService.initiatePayment({
      bookingId:  result.booking.id,
      userId:     req.user.id,
      email:      req.user.email,
      amountKobo: result.finalCharge,
      metadata:   { trip_id: result.trip.id, booking_id: result.booking.id }
    });

    logger.info(`Booking created: ${result.booking.id} for trip ${trip_id}`);
    return res.status(201).json({
      success: true,
      message: 'Booking initiated. Complete payment to confirm.',
      data: { booking: result.booking, payment_url: paymentUrl, amount_kobo: result.finalCharge }
    });
  } catch (err) { next(err); }
});

// ── GET /bookings/:id ──────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows: [booking] } = await query(
      `SELECT b.*, t.airport_code, t.departure_date, t.departure_time, t.flight_number,
              t.status AS trip_status, a.name AS airport_name,
              u.full_name AS passenger_name
       FROM bookings b
       JOIN trips t ON t.id = b.trip_id
       JOIN airports a ON a.code = t.airport_code
       JOIN users u ON u.id = b.user_id
       WHERE b.id = $1 AND b.user_id = $2`, [req.params.id, req.user.id]
    );
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    return res.json({ success: true, data: booking });
  } catch (err) { next(err); }
});

// ── DELETE /bookings/:id – cancel booking ──────────────────────
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { reason } = req.body;
    await withTransaction(async (client) => {
      const { rows: [booking] } = await client.query(
        `SELECT b.*, t.departure_date FROM bookings b JOIN trips t ON t.id = b.trip_id
         WHERE b.id = $1 AND b.user_id = $2 FOR UPDATE`, [req.params.id, req.user.id]
      );
      if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
      if (['cancelled','completed'].includes(booking.status)) {
        throw Object.assign(new Error(`Booking already ${booking.status}`), { status: 400 });
      }

      await client.query(
        `UPDATE bookings SET status = 'cancelled', cancellation_reason = $1, cancelled_at = NOW() WHERE id = $2`,
        [reason || 'Cancelled by passenger', booking.id]
      );
      await client.query(`UPDATE trips SET seats_taken = seats_taken - 1 WHERE id = $1`, [booking.trip_id]);

      if (booking.payment_status === 'success') {
        await paymentService.initiateRefund(booking.id, booking.amount_kobo);
      }
    });
    return res.json({ success: true, message: 'Booking cancelled' });
  } catch (err) { next(err); }
});

module.exports = router;
