'use strict';
const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const Joi      = require('joi');
const { v4: uuid } = require('uuid');
const { query, withTransaction } = require('../config/database');
const { generateTokenPair, requireAuth } = require('../middleware/auth');
const { setOTP, getOTP, delOTP, blacklistToken } = require('../config/redis');
const smsService   = require('../services/smsService');
const emailService = require('../services/emailService');
const logger       = require('../utils/logger');

// ── Validation Schemas ──────────────────────────────────────────
const registerSchema = Joi.object({
  full_name: Joi.string().min(2).max(100).required(),
  phone:     Joi.string().pattern(/^\+?[1-9]\d{9,14}$/).required(),
  email:     Joi.string().email().optional(),
  password:  Joi.string().min(8).required(),
  city:      Joi.string().optional().default('Lagos')
});

const loginSchema = Joi.object({
  identifier: Joi.string().required(),  // phone or email
  password:   Joi.string().required()
});

// ── POST /auth/register ────────────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { error, value } = registerSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });

    // Check duplicate
    const existing = await query(
      `SELECT id FROM users WHERE phone = $1 OR (email IS NOT NULL AND email = $2)`,
      [value.phone, value.email || null]
    );
    if (existing.rows.length) {
      return res.status(409).json({ success: false, message: 'Phone or email already registered' });
    }

    const password_hash = await bcrypt.hash(value.password, 12);

    const { rows } = await query(
      `INSERT INTO users (id, full_name, phone, email, password_hash, city)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, full_name, phone, email, city, created_at`,
      [uuid(), value.full_name, value.phone, value.email || null, password_hash, value.city]
    );
    const user = rows[0];

    // Create wallet
    await query(`INSERT INTO wallets (user_id, balance_kobo) VALUES ($1, 0)`, [user.id]);

    // Send OTP
    const otp = generateOTP();
    await setOTP(value.phone, otp);
    await smsService.sendOTP(value.phone, otp, value.full_name);

    // Welcome email
    if (value.email) {
      await emailService.sendWelcome(value.email, value.full_name);
    }

    logger.info(`New user registered: ${user.id} (${user.phone})`);

    const tokens = generateTokenPair({ ...user, role: 'passenger' });
    return res.status(201).json({
      success: true,
      message: 'Registration successful. Please verify your phone.',
      data: { user, ...tokens }
    });
  } catch (err) { next(err); }
});

// ── POST /auth/login ───────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });

    const { rows } = await query(
      `SELECT id, full_name, phone, email, password_hash, status, is_premium, phone_verified
       FROM users WHERE phone = $1 OR email = $1`,
      [value.identifier]
    );

    if (!rows.length || !(await bcrypt.compare(value.password, rows[0].password_hash))) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const user = rows[0];
    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: `Account is ${user.status}` });
    }

    // Update last_seen
    await query(`UPDATE users SET last_seen = NOW() WHERE id = $1`, [user.id]);

    const tokens = generateTokenPair({ ...user, role: 'passenger' });
    await query(`UPDATE users SET refresh_token = $1 WHERE id = $2`, [tokens.refreshToken, user.id]);

    delete user.password_hash;
    return res.json({
      success: true,
      message: 'Login successful',
      data: { user, ...tokens }
    });
  } catch (err) { next(err); }
});

// ── POST /auth/driver/login ────────────────────────────────────
router.post('/driver/login', async (req, res, next) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: 'Phone and password required' });
    }

    const { rows } = await query(
      `SELECT id, full_name, phone, password_hash, status, kyc_status, airport_zone
       FROM drivers WHERE phone = $1 OR email = $1`,
      [identifier]
    );

    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const driver = rows[0];
    if (driver.status === 'suspended') {
      return res.status(403).json({ success: false, message: 'Driver account suspended' });
    }

    const tokens = generateTokenPair({ ...driver, role: 'driver' });
    await query(`UPDATE drivers SET refresh_token = $1 WHERE id = $2`, [tokens.refreshToken, driver.id]);

    delete driver.password_hash;
    return res.json({ success: true, message: 'Driver login successful', data: { driver, ...tokens } });
  } catch (err) { next(err); }
});

// ── POST /auth/verify-otp ──────────────────────────────────────
router.post('/verify-otp', requireAuth, async (req, res, next) => {
  try {
    const { otp } = req.body;
    if (!otp) return res.status(400).json({ success: false, message: 'OTP is required' });

    const stored = await getOTP(req.user.phone);
    if (!stored || stored !== otp.toString()) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    await query(`UPDATE users SET phone_verified = TRUE WHERE id = $1`, [req.user.id]);
    await delOTP(req.user.phone);

    return res.json({ success: true, message: 'Phone verified successfully' });
  } catch (err) { next(err); }
});

// ── POST /auth/resend-otp ──────────────────────────────────────
router.post('/resend-otp', requireAuth, async (req, res, next) => {
  try {
    const otp = generateOTP();
    await setOTP(req.user.phone, otp);
    await smsService.sendOTP(req.user.phone, otp, req.user.full_name);
    return res.json({ success: true, message: 'OTP resent to your phone' });
  } catch (err) { next(err); }
});

// ── POST /auth/forgot-password ─────────────────────────────────
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone required' });

    const { rows } = await query(`SELECT id, full_name, phone FROM users WHERE phone = $1`, [phone]);
    if (!rows.length) {
      // Don't reveal if user exists
      return res.json({ success: true, message: 'If that number is registered, an OTP has been sent' });
    }

    const otp = generateOTP();
    await setOTP(phone, otp);
    await smsService.sendOTP(phone, otp, rows[0].full_name, 'password-reset');

    return res.json({ success: true, message: 'OTP sent to your registered phone' });
  } catch (err) { next(err); }
});

// ── POST /auth/reset-password ──────────────────────────────────
router.post('/reset-password', async (req, res, next) => {
  try {
    const { phone, otp, new_password } = req.body;
    if (!phone || !otp || !new_password) {
      return res.status(400).json({ success: false, message: 'phone, otp and new_password required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    const stored = await getOTP(phone);
    if (!stored || stored !== otp.toString()) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await query(`UPDATE users SET password_hash = $1 WHERE phone = $2`, [hash, phone]);
    await delOTP(phone);

    return res.json({ success: true, message: 'Password reset successful' });
  } catch (err) { next(err); }
});

// ── POST /auth/refresh ─────────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ success: false, message: 'Refresh token required' });

    const jwt = require('jsonwebtoken');
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }

    const { rows } = await query(
      `SELECT id, full_name, phone, status FROM users WHERE id = $1 AND refresh_token = $2`,
      [decoded.id, refreshToken]
    );
    if (!rows.length) return res.status(401).json({ success: false, message: 'Refresh token mismatch' });

    const tokens = generateTokenPair({ ...rows[0], role: 'passenger' });
    await query(`UPDATE users SET refresh_token = $1 WHERE id = $2`, [tokens.refreshToken, rows[0].id]);

    return res.json({ success: true, data: tokens });
  } catch (err) { next(err); }
});

// ── POST /auth/logout ──────────────────────────────────────────
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const expSeconds = 7 * 24 * 60 * 60; // 7 days
    if (req.user.jti) await blacklistToken(req.user.jti, expSeconds);
    await query(`UPDATE users SET refresh_token = NULL, fcm_token = NULL WHERE id = $1`, [req.user.id]);
    return res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) { next(err); }
});

// ── POST /auth/fcm-token ───────────────────────────────────────
router.post('/fcm-token', requireAuth, async (req, res, next) => {
  try {
    const { token, device_info } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'FCM token required' });
    await query(
      `UPDATE users SET fcm_token = $1, device_info = $2 WHERE id = $3`,
      [token, JSON.stringify(device_info || {}), req.user.id]
    );
    return res.json({ success: true, message: 'FCM token updated' });
  } catch (err) { next(err); }
});

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

module.exports = router;
