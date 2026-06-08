'use strict';
const { createClient } = require('redis');
const logger = require('../utils/logger');

let client;

async function connectRedis() {
  client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  client.on('error', err => logger.warn('Redis error:', err.message));
  await client.connect();
  return client;
}

const get    = (key)       => client?.get(key);
const set    = (key, val, ttl) => ttl ? client?.setEx(key, ttl, JSON.stringify(val)) : client?.set(key, JSON.stringify(val));
const del    = (key)       => client?.del(key);
const exists = (key)       => client?.exists(key);
const getJSON = async (key) => { const v = await get(key); return v ? JSON.parse(v) : null; };
const setJSON = (key, val, ttl) => set(key, val, ttl);

// OTP cache: 10 minutes TTL
const setOTP  = (phone, otp)  => client?.setEx(`otp:${phone}`, 600, otp);
const getOTP  = (phone)       => get(`otp:${phone}`);
const delOTP  = (phone)       => del(`otp:${phone}`);

// Session / token blacklist
const blacklistToken = (jti, exp) => client?.setEx(`bl:${jti}`, exp, '1');
const isBlacklisted  = async (jti) => (await exists(`bl:${jti}`)) === 1;

// Driver location cache (30 second TTL)
const setDriverLocation = (driverId, lat, lng) =>
  client?.setEx(`dloc:${driverId}`, 30, JSON.stringify({ lat, lng, ts: Date.now() }));
const getDriverLocation = (driverId) => getJSON(`driverLoc:${driverId}`);

// Trip match cache (2 minute TTL)
const setMatchCache = (key, matches) => setJSON(`match:${key}`, matches, 120);
const getMatchCache = (key) => getJSON(`match:${key}`);

module.exports = {
  connectRedis, get, set, del, exists, getJSON, setJSON,
  setOTP, getOTP, delOTP,
  blacklistToken, isBlacklisted,
  setDriverLocation, getDriverLocation,
  setMatchCache, getMatchCache,
  getClient: () => client
};
