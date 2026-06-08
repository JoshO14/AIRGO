// ─────────────────────────────────────────────
//  src/services/smsService.js
// ─────────────────────────────────────────────
'use strict';
const twilio = require('twilio');
const logger = require('../utils/logger');

let client;
function getClient() {
  if (!client && process.env.TWILIO_ACCOUNT_SID) {
    client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

async function sendOTP(phone, otp, name, type = 'verification') {
  const c = getClient();
  if (!c) { logger.warn(`SMS (mock) → ${phone}: OTP ${otp}`); return; }

  const messages = {
    verification:   `Hi ${name}, your Airgo verification code is: ${otp}. Expires in 10 minutes.`,
    'password-reset': `Hi ${name}, your Airgo password reset code is: ${otp}. Expires in 10 minutes.`
  };

  try {
    await c.messages.create({
      body: messages[type] || messages.verification,
      from: process.env.TWILIO_PHONE_NUMBER,
      to:   phone
    });
    logger.info(`SMS OTP sent to ${phone}`);
  } catch (err) {
    logger.error(`SMS send failed to ${phone}: ${err.message}`);
    // Don't throw — log and continue
  }
}

async function sendText(phone, message) {
  const c = getClient();
  if (!c) { logger.warn(`SMS (mock) → ${phone}: ${message}`); return; }
  try {
    await c.messages.create({ body: message, from: process.env.TWILIO_PHONE_NUMBER, to: phone });
  } catch (err) {
    logger.error(`SMS failed: ${err.message}`);
  }
}

module.exports = { sendOTP, sendText };
