'use strict';
const axios  = require('axios');
const logger = require('../utils/logger');

const FROM   = `${process.env.EMAIL_FROM_NAME || 'Airgo'} <${process.env.EMAIL_FROM || 'noreply@airgo.ng'}>`;
const RESEND = 'https://api.resend.com/emails';

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    logger.warn(`Email (mock) → ${to}: ${subject}`);
    return;
  }
  try {
    const { data } = await axios.post(RESEND, { from: FROM, to, subject, html }, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }
    });
    logger.info(`Email sent to ${to}: ${data.id}`);
    return data;
  } catch (err) {
    logger.error(`Email failed to ${to}: ${err.response?.data?.message || err.message}`);
  }
}

function sendWelcome(email, name) {
  return sendEmail({
    to: email, subject: 'Welcome to Airgo! ✈️',
    html: `<div style="font-family:sans-serif;max-width:520px;margin:auto;">
      <div style="background:#0F3460;padding:32px;border-radius:12px 12px 0 0;text-align:center;">
        <h1 style="color:#E8B84B;letter-spacing:2px;font-size:28px;">AIRGO</h1>
        <p style="color:rgba(255,255,255,0.7);margin:0;">Airport Ride Sharing</p>
      </div>
      <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-radius:0 0 12px 12px;">
        <h2 style="color:#111827;">Welcome, ${name}! 👋</h2>
        <p style="color:#6b7280;line-height:1.6;">Your account is ready. Start finding co-travelers to share your next airport ride — and save up to 70% on transport costs.</p>
        <div style="background:#f7f8fc;border-radius:8px;padding:16px;margin:20px 0;">
          <p style="margin:0;font-size:13px;color:#374151;"><strong>✅ Verify your phone</strong> to start booking rides.<br>
          <strong>🚗 Create your first trip</strong> to get matched with nearby travelers.<br>
          <strong>💰 Save money</strong> on every airport journey.</p>
        </div>
        <p style="color:#6b7280;font-size:13px;">Need help? Reply to this email or message us on WhatsApp.</p>
      </div>
    </div>`
  });
}

function sendBookingConfirmation(email, name, booking) {
  return sendEmail({
    to: email, subject: `✅ Ride Confirmed — ${booking.airport_code} on ${booking.departure_date}`,
    html: `<div style="font-family:sans-serif;max-width:520px;margin:auto;">
      <div style="background:#0F3460;padding:24px;border-radius:12px 12px 0 0;text-align:center;">
        <h2 style="color:#E8B84B;margin:0;">Booking Confirmed</h2>
      </div>
      <div style="background:#fff;padding:28px;border:1px solid #e5e7eb;border-radius:0 0 12px 12px;">
        <p style="color:#111827;">Hi <strong>${name}</strong>, your seat is confirmed!</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
          <tr><td style="padding:8px 0;color:#6b7280;border-bottom:1px solid #f0f1f4;">Booking Ref</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #f0f1f4;text-align:right;">#${booking.id.slice(0,8).toUpperCase()}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;border-bottom:1px solid #f0f1f4;">Airport</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #f0f1f4;text-align:right;">${booking.airport_code}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;border-bottom:1px solid #f0f1f4;">Date</td><td style="padding:8px 0;font-weight:600;border-bottom:1px solid #f0f1f4;text-align:right;">${booking.departure_date}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;">Amount Paid</td><td style="padding:8px 0;font-weight:700;color:#1D9E75;text-align:right;">₦${(booking.amount_kobo / 100).toLocaleString()}</td></tr>
        </table>
        <p style="color:#6b7280;font-size:13px;">You will receive an SMS when your driver is on the way. Safe travels! ✈️</p>
      </div>
    </div>`
  });
}

function sendDriverAssigned(email, name, driver, trip) {
  return sendEmail({
    to: email, subject: `🚗 Driver Assigned — ${driver.full_name} will pick you up`,
    html: `<div style="font-family:sans-serif;max-width:520px;margin:auto;padding:24px;">
      <h2 style="color:#0F3460;">Your driver has been assigned</h2>
      <p>Hi <strong>${name}</strong>, your driver for the trip to <strong>${trip.airport_code}</strong> is confirmed:</p>
      <div style="background:#f7f8fc;border-radius:10px;padding:16px;margin:16px 0;">
        <p style="margin:4px 0;"><strong>${driver.full_name}</strong> · ⭐ ${driver.rating}</p>
        <p style="margin:4px 0;color:#6b7280;">${driver.vehicle_make} ${driver.vehicle_model} · ${driver.plate_number}</p>
      </div>
      <p style="color:#6b7280;font-size:13px;">Pickup at ${trip.departure_time}. Be ready 10 minutes early.</p>
    </div>`
  });
}

module.exports = { sendEmail, sendWelcome, sendBookingConfirmation, sendDriverAssigned };
