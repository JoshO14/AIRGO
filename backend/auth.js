'use strict';
const jwt    = require('jsonwebtoken');
const { query } = require('../config/database');
const { isBlacklisted } = require('../config/redis');

// ── Token Generation ────────────────────────────────────────────
function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    issuer: 'airgo-api'
  });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
    issuer: 'airgo-api'
  });
}

function generateTokenPair(user) {
  const payload = { id: user.id, role: user.role || 'passenger', jti: require('uuid').v4() };
  return {
    accessToken:  signAccessToken(payload),
    refreshToken: signRefreshToken({ id: user.id, jti: payload.jti })
  };
}

// ── Middleware: Require Passenger Auth ──────────────────────────
async function requireAuth(req, res, next) {
  try {
    const token = extractBearer(req);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (await isBlacklisted(decoded.jti)) {
      return res.status(401).json({ success: false, message: 'Token has been revoked' });
    }

    const { rows } = await query(
      `SELECT id, full_name, email, phone, status, is_premium, kyc_status, airgo_points
       FROM users WHERE id = $1`, [decoded.id]
    );
    if (!rows.length || rows[0].status !== 'active') {
      return res.status(401).json({ success: false, message: 'User not found or suspended' });
    }

    req.user = { ...rows[0], role: decoded.role, jti: decoded.jti };
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Unauthorised: ' + err.message });
  }
}

// ── Middleware: Require Driver Auth ─────────────────────────────
async function requireDriver(req, res, next) {
  try {
    const token = extractBearer(req);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role !== 'driver') {
      return res.status(403).json({ success: false, message: 'Driver access required' });
    }

    const { rows } = await query(
      `SELECT id, full_name, phone, status, kyc_status, airport_zone, vehicle_capacity
       FROM drivers WHERE id = $1`, [decoded.id]
    );
    if (!rows.length || rows[0].status === 'suspended') {
      return res.status(401).json({ success: false, message: 'Driver not found or suspended' });
    }

    req.driver = { ...rows[0], jti: decoded.jti };
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Unauthorised: ' + err.message });
  }
}

// ── Middleware: Require Admin Auth ──────────────────────────────
async function requireAdmin(req, res, next) {
  try {
    const token = extractBearer(req);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!['admin', 'super_admin', 'staff'].includes(decoded.role)) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const { rows } = await query(
      `SELECT id, full_name, email, role, permissions FROM admins WHERE id = $1 AND is_active = TRUE`,
      [decoded.id]
    );
    if (!rows.length) return res.status(401).json({ success: false, message: 'Admin not found' });

    req.admin = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Unauthorised: ' + err.message });
  }
}

// ── Middleware: Require Super Admin ─────────────────────────────
function requireSuperAdmin(req, res, next) {
  requireAdmin(req, res, () => {
    if (req.admin?.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Super admin access required' });
    }
    next();
  });
}

function extractBearer(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw Object.assign(new Error('No Bearer token provided'), { name: 'JsonWebTokenError' });
  }
  return header.slice(7);
}

module.exports = {
  signAccessToken, signRefreshToken, generateTokenPair,
  requireAuth, requireDriver, requireAdmin, requireSuperAdmin
};
