'use strict';
const router = require('express').Router();
const Joi    = require('joi');
const { v4: uuid } = require('uuid');
const { query, withTransaction } = require('../config/database');
const { requireAuth, requireDriver, requireAdmin } = require('../middleware/auth');
const notifService = require('../services/notificationService');
const logger = require('../utils/logger');

const tripSchema = Joi.object({
  airport_code:   Joi.string().length(3).uppercase().required(),
  pickup_address: Joi.string().min(5).required(),
  pickup_lat:     Joi.number().optional(),
  pickup_lng:     Joi.number().optional(),
  flight_number:  Joi.string().max(10).optional(),
  airline:        Joi.string().optional(),
  flight_time:    Joi.date().iso().required(),
  departure_date: Joi.date().iso().required(),
  departure_time: Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
  seats_total:    Joi.number().integer().min(1).max(6).default(4),
  luggage_type:   Joi.string().valid('carry_on','checked_1','checked_2','oversized').default('checked_1'),
  notes:          Joi.string().max(300).optional(),
  preferences:    Joi.object().optional()
});

// ── GET /trips – search/list available trips ───────────────────
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const {
      airport_code, departure_date, pickup_lat, pickup_lng,
      flight_time, luggage_type, page = 1, limit = 20
    } = req.query;

    if (!airport_code || !departure_date) {
      return res.status(400).json({ success: false, message: 'airport_code and departure_date required' });
    }

    const offset = (Number(page) - 1) * Number(limit);

    // Use matching function if coordinates available
    if (pickup_lat && pickup_lng && flight_time) {
      const { rows } = await query(
        `SELECT m.trip_id, m.score, m.score_breakdown,
                t.*, a.name AS airport_name, a.city AS airport_city,
                u.full_name AS organizer_name, u.rating AS organizer_rating,
                u.total_trips AS organizer_trips, u.avatar_url AS organizer_avatar,
                (SELECT COUNT(*) FROM bookings b WHERE b.trip_id = t.id AND b.status != 'cancelled') AS confirmed_passengers
         FROM find_trip_matches($1,$2,$3,$4,$5) m
         JOIN trips t ON t.id = m.trip_id
         JOIN airports a ON a.code = t.airport_code
         JOIN users u ON u.id = t.organizer_id
         WHERE t.organizer_id != $6
         ORDER BY m.score DESC
         LIMIT $7 OFFSET $8`,
        [airport_code, flight_time, pickup_lat, pickup_lng, luggage_type || 'checked_1', req.user.id, limit, offset]
      );
      return res.json({ success: true, data: { trips: rows, page: Number(page), limit: Number(limit) } });
    }

    // Fallback basic search
    const { rows } = await query(
      `SELECT t.*, a.name AS airport_name,
              u.full_name AS organizer_name, u.rating AS organizer_rating,
              u.avatar_url AS organizer_avatar,
              (t.seats_total - t.seats_taken) AS seats_available
       FROM trips t
       JOIN airports a ON a.code = t.airport_code
       JOIN users u ON u.id = t.organizer_id
       WHERE t.airport_code = $1
         AND t.departure_date = $2
         AND t.status = 'matching'
         AND t.seats_taken < t.seats_total
         AND t.organizer_id != $3
       ORDER BY t.departure_time ASC
       LIMIT $4 OFFSET $5`,
      [airport_code, departure_date, req.user.id, limit, offset]
    );

    return res.json({ success: true, data: { trips: rows, page: Number(page), limit: Number(limit) } });
  } catch (err) { next(err); }
});

// ── POST /trips – create a new trip ───────────────────────────
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { error, value } = tripSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });

    // Validate flight time is in the future
    if (new Date(value.flight_time) < new Date()) {
      return res.status(400).json({ success: false, message: 'Flight time must be in the future' });
    }

    const { rows } = await query(
      `INSERT INTO trips (id, organizer_id, airport_code, pickup_address, pickup_lat, pickup_lng,
        flight_number, airline, flight_time, departure_date, departure_time,
        seats_total, luggage_type, notes, preferences)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [uuid(), req.user.id, value.airport_code, value.pickup_address,
       value.pickup_lat || null, value.pickup_lng || null,
       value.flight_number || null, value.airline || null,
       value.flight_time, value.departure_date, value.departure_time,
       value.seats_total, value.luggage_type, value.notes || null,
       JSON.stringify(value.preferences || {})]
    );

    const trip = rows[0];
    logger.info(`Trip created: ${trip.id} by user ${req.user.id}`);

    // Emit to socket for real-time admin view
    req.app.get('io')?.emit('trip:new', { tripId: trip.id, airport: trip.airport_code });

    return res.status(201).json({ success: true, message: 'Trip created successfully', data: trip });
  } catch (err) { next(err); }
});

// ── GET /trips/:id – get single trip details ───────────────────
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT t.*,
              a.name AS airport_name, a.city AS airport_city, a.latitude AS airport_lat, a.longitude AS airport_lng,
              u.full_name AS organizer_name, u.rating AS organizer_rating, u.total_trips AS organizer_trips,
              u.avatar_url AS organizer_avatar, u.is_premium AS organizer_premium,
              d.full_name AS driver_name, d.rating AS driver_rating, d.vehicle_make,
              d.vehicle_model, d.plate_number, d.vehicle_color, d.avatar_url AS driver_avatar,
              json_agg(DISTINCT jsonb_build_object(
                'id', b.id, 'user_id', b.user_id, 'pickup_address', b.pickup_address,
                'pickup_order', b.pickup_order, 'status', b.status,
                'passenger_name', pu.full_name, 'passenger_rating', pu.rating, 'passenger_avatar', pu.avatar_url
              )) FILTER (WHERE b.id IS NOT NULL) AS passengers
       FROM trips t
       JOIN airports a ON a.code = t.airport_code
       JOIN users u    ON u.id = t.organizer_id
       LEFT JOIN drivers d ON d.id = t.driver_id
       LEFT JOIN bookings b ON b.trip_id = t.id AND b.status != 'cancelled'
       LEFT JOIN users pu ON pu.id = b.user_id
       WHERE t.id = $1
       GROUP BY t.id, a.code, u.id, d.id`,
      [req.params.id]
    );

    if (!rows.length) return res.status(404).json({ success: false, message: 'Trip not found' });

    // Calculate fares
    const trip = rows[0];
    if (trip.total_fare) {
      const pax = trip.seats_total;
      const feeRate = req.user.is_premium ? 6 : 10;
      trip.fare_per_person = Math.floor(trip.total_fare / pax);
      trip.service_fee     = Math.round(trip.fare_per_person * feeRate / 100);
      trip.your_total      = trip.fare_per_person + trip.service_fee;
      trip.you_save        = trip.total_fare - trip.fare_per_person;
    }

    return res.json({ success: true, data: trip });
  } catch (err) { next(err); }
});

// ── PATCH /trips/:id – update trip (organizer only) ────────────
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows: [trip] } = await query(`SELECT * FROM trips WHERE id = $1`, [req.params.id]);
    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.organizer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the trip organizer can update this trip' });
    }
    if (['active','completed','cancelled'].includes(trip.status)) {
      return res.status(400).json({ success: false, message: `Cannot update a ${trip.status} trip` });
    }

    const allowed = ['notes', 'pickup_address', 'departure_time', 'luggage_type', 'preferences'];
    const updates = [];
    const values  = [];
    let idx = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = $${idx++}`);
        values.push(key === 'preferences' ? JSON.stringify(req.body[key]) : req.body[key]);
      }
    }

    if (!updates.length) return res.status(400).json({ success: false, message: 'No valid fields to update' });

    values.push(req.params.id);
    const { rows } = await query(
      `UPDATE trips SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`, values
    );

    return res.json({ success: true, message: 'Trip updated', data: rows[0] });
  } catch (err) { next(err); }
});

// ── DELETE /trips/:id – cancel trip ───────────────────────────
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { reason } = req.body;
    const { rows: [trip] } = await query(`SELECT * FROM trips WHERE id = $1`, [req.params.id]);

    if (!trip) return res.status(404).json({ success: false, message: 'Trip not found' });
    if (trip.organizer_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the organizer can cancel this trip' });
    }
    if (['completed','cancelled'].includes(trip.status)) {
      return res.status(400).json({ success: false, message: `Trip already ${trip.status}` });
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE trips SET status = 'cancelled', cancelled_reason = $1, cancelled_by = $2 WHERE id = $3`,
        [reason || 'Cancelled by organizer', req.user.id, trip.id]
      );

      // Get all confirmed bookings to refund
      const { rows: bookings } = await client.query(
        `SELECT b.*, u.fcm_token, u.full_name FROM bookings b JOIN users u ON u.id = b.user_id
         WHERE b.trip_id = $1 AND b.status = 'confirmed'`, [trip.id]
      );

      for (const booking of bookings) {
        await client.query(
          `UPDATE bookings SET status = 'cancelled', cancellation_reason = $1 WHERE id = $2`,
          ['Trip cancelled by organizer', booking.id]
        );
        // Queue refund (handled by payment service)
        if (booking.payment_status === 'success') {
          await client.query(
            `UPDATE payments SET status = 'refunded' WHERE booking_id = $1`, [booking.id]
          );
        }
        // Notify each passenger
        if (booking.fcm_token) {
          notifService.send(booking.fcm_token, {
            title: 'Trip Cancelled',
            body:  `Your ride to ${trip.airport_code} on ${trip.departure_date} was cancelled. A refund has been initiated.`,
            data:  { type: 'trip_cancelled', trip_id: trip.id }
          });
        }
      }
    });

    return res.json({ success: true, message: 'Trip cancelled. Passengers have been notified.' });
  } catch (err) { next(err); }
});

// ── GET /trips/:id/messages – trip group chat ──────────────────
router.get('/:id/messages', requireAuth, async (req, res, next) => {
  try {
    const { limit = 50, before } = req.query;
    const params = [req.params.id, limit];
    const beforeClause = before ? `AND m.created_at < $3` : '';
    if (before) params.push(before);

    const { rows } = await query(
      `SELECT m.*, 
              CASE WHEN m.sender_type = 'passenger' THEN u.full_name
                   WHEN m.sender_type = 'driver' THEN d.full_name
                   ELSE 'System'
              END AS sender_name,
              CASE WHEN m.sender_type = 'passenger' THEN u.avatar_url
                   WHEN m.sender_type = 'driver' THEN d.avatar_url
              END AS sender_avatar
       FROM messages m
       LEFT JOIN users u   ON u.id = m.sender_id AND m.sender_type = 'passenger'
       LEFT JOIN drivers d ON d.id = m.sender_id AND m.sender_type = 'driver'
       WHERE m.trip_id = $1 ${beforeClause}
       ORDER BY m.created_at DESC LIMIT $2`,
      params
    );

    return res.json({ success: true, data: rows.reverse() });
  } catch (err) { next(err); }
});

// ── GET /trips/my/upcoming ─────────────────────────────────────
router.get('/my/upcoming', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT t.*, a.name AS airport_name,
              b.id AS booking_id, b.status AS booking_status, b.amount_kobo,
              d.full_name AS driver_name, d.plate_number, d.vehicle_make, d.vehicle_model,
              d.current_lat, d.current_lng
       FROM bookings b
       JOIN trips t ON t.id = b.trip_id
       JOIN airports a ON a.code = t.airport_code
       LEFT JOIN drivers d ON d.id = t.driver_id
       WHERE b.user_id = $1
         AND b.status IN ('confirmed','pending')
         AND t.departure_date >= CURRENT_DATE
         AND t.status NOT IN ('cancelled','completed')
       ORDER BY t.departure_date ASC, t.departure_time ASC`,
      [req.user.id]
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /trips/my/history ──────────────────────────────────────
router.get('/my/history', requireAuth, async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const { rows } = await query(
      `SELECT t.id, t.airport_code, t.pickup_address, t.flight_number, t.departure_date,
              t.departure_time, t.status,
              a.name AS airport_name,
              b.id AS booking_id, b.amount_kobo, b.status AS booking_status,
              (SELECT COUNT(*) FROM bookings b2 WHERE b2.trip_id = t.id AND b2.status='completed') AS total_passengers,
              r.score AS my_rating
       FROM bookings b
       JOIN trips t ON t.id = b.trip_id
       JOIN airports a ON a.code = t.airport_code
       LEFT JOIN ratings r ON r.trip_id = t.id AND r.rater_id = $1
       WHERE b.user_id = $1
         AND (t.status = 'completed' OR b.status IN ('cancelled','refunded'))
       ORDER BY t.departure_date DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    return res.json({ success: true, data: { trips: rows, page: Number(page), limit: Number(limit) } });
  } catch (err) { next(err); }
});

module.exports = router;
