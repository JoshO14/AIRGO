'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 5000);
const API_VERSION = process.env.API_VERSION || 'v1';
const BASE = `/api/${API_VERSION}`;
const BACKEND_DIR = __dirname;
const FRONTEND_DIR = path.resolve(BACKEND_DIR, '..');

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const airports = [
  { code: 'LOS', name: 'Murtala Muhammed International Airport', city: 'Lagos', active_trips: 62, drivers_assigned: 38, status: 'active' },
  { code: 'ABV', name: 'Nnamdi Azikiwe International Airport', city: 'Abuja', active_trips: 41, drivers_assigned: 22, status: 'active' },
  { code: 'QUO', name: 'Victor Attah International Airport', city: 'Uyo', active_trips: 24, drivers_assigned: 13, status: 'active' },
  { code: 'PHC', name: 'Port Harcourt International Airport', city: 'Port Harcourt', active_trips: 28, drivers_assigned: 15, status: 'active' },
  { code: 'ENU', name: 'Akanu Ibiam International Airport', city: 'Enugu', active_trips: 17, drivers_assigned: 9, status: 'limited' }
];

const users = [
  { id: 'usr-001', full_name: 'Amaka T.', email: 'amaka@email.com', phone: '+234 801 234 5678', trips: 34, rating: 4.9, status: 'active' },
  { id: 'usr-002', full_name: 'David A.', email: 'david@corp.ng', phone: '+234 802 345 6789', trips: 24, rating: 4.8, status: 'active' },
  { id: 'usr-003', full_name: 'Kemi O.', email: 'kemi@gmail.com', phone: '+234 803 456 7890', trips: 18, rating: 4.7, status: 'active' },
  { id: 'usr-004', full_name: 'Bode I.', email: 'bode@biz.ng', phone: '+234 805 678 9012', trips: 12, rating: 3.9, status: 'suspended' }
];

const drivers = [
  { id: 'drv-001', full_name: 'Emeka O.', vehicle: 'Toyota Camry', plate_number: 'KJA-234KJ', airport_zone: 'LOS', trips: 142, rating: 4.9, kyc_status: 'verified', status: 'active', online: false, earnings_today: 12600 },
  { id: 'drv-002', full_name: 'Segun A.', vehicle: 'Honda Accord', plate_number: 'ABJ-112GH', airport_zone: 'ABV', trips: 88, rating: 4.7, kyc_status: 'verified', status: 'active', online: true, earnings_today: 9800 },
  { id: 'drv-003', full_name: 'Ngozi F.', vehicle: 'Toyota Corolla', plate_number: 'PHC-088KK', airport_zone: 'PHC', trips: 56, rating: 4.8, kyc_status: 'pending', status: 'pending', online: false, earnings_today: 0 }
];

const trips = [
  {
    id: 'TRP-4829',
    airport_code: 'LOS',
    airport_name: 'Murtala Muhammed International Airport',
    organizer_name: 'Amaka T.',
    route: 'Lekki Phase 1 to LOS',
    pickup_address: 'Lekki Phase 1',
    departure_date: '2026-06-12',
    departure_time: '07:45',
    flight_number: 'P47120',
    seats_total: 4,
    seats_taken: 3,
    match_score: 98,
    fare_each: 4200,
    status: 'matching',
    luggage_type: 'checked_1',
    driver_id: 'drv-001'
  },
  {
    id: 'TRP-4830',
    airport_code: 'LOS',
    airport_name: 'Murtala Muhammed International Airport',
    organizer_name: 'David A.',
    route: 'Victoria Island to LOS',
    pickup_address: 'Victoria Island',
    departure_date: '2026-06-12',
    departure_time: '08:00',
    flight_number: 'Q9321',
    seats_total: 4,
    seats_taken: 2,
    match_score: 92,
    fare_each: 3900,
    status: 'active',
    luggage_type: 'carry_on',
    driver_id: 'drv-001'
  },
  {
    id: 'TRP-4831',
    airport_code: 'ABV',
    airport_name: 'Nnamdi Azikiwe International Airport',
    organizer_name: 'Kemi O.',
    route: 'Ikeja to ABV connection',
    pickup_address: 'Ikeja GRA',
    departure_date: '2026-06-13',
    departure_time: '09:30',
    flight_number: 'W3731',
    seats_total: 3,
    seats_taken: 1,
    match_score: 87,
    fare_each: 6100,
    status: 'matching',
    luggage_type: 'checked_2',
    driver_id: 'drv-002'
  }
];

const bookings = [
  { id: 'BKG-1001', trip_id: 'TRP-4829', user_id: 'usr-002', amount_kobo: 462000, status: 'confirmed', payment_status: 'success' }
];

const notifications = [
  { id: 'ntf-001', title: 'Driver is 8 minutes away', body: 'Emeka is heading to your pickup point.', type: 'driver_location', read: false },
  { id: 'ntf-002', title: 'Ride confirmed', body: 'Your seat on Amaka ride to LOS is secured.', type: 'booking', read: false },
  { id: 'ntf-003', title: 'New match found', body: 'A 98% route and flight-time match is available.', type: 'matching', read: true }
];

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
  });
}

function safeStaticPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]);
  const fileName = cleanPath === '/' ? 'index.html' : cleanPath.replace(/^\/+/, '');
  const resolved = path.resolve(FRONTEND_DIR, fileName);
  if (!resolved.startsWith(FRONTEND_DIR)) return null;
  return resolved;
}

function serveStatic(req, res) {
  const staticPath = safeStaticPath(req.url);
  if (!staticPath) return sendJson(res, 403, { success: false, message: 'Forbidden' });

  fs.stat(staticPath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      return sendJson(res, 404, { success: false, message: 'Page or asset not found' });
    }
    const ext = path.extname(staticPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(staticPath).pipe(res);
  });
}

function listBackendFiles() {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(BACKEND_DIR, full).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(full);
      else if (!rel.endsWith('.log')) files.push(rel);
    }
  }
  walk(BACKEND_DIR);
  return files.sort();
}

function publicTrip(trip) {
  const driver = drivers.find(item => item.id === trip.driver_id);
  return {
    ...trip,
    seats_available: trip.seats_total - trip.seats_taken,
    service_fee: Math.round(trip.fare_each * 0.1),
    total_with_fee: trip.fare_each + Math.round(trip.fare_each * 0.1),
    driver
  };
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { success: true });

  const route = url.pathname.slice(BASE.length) || '/';

  if (req.method === 'GET' && route === '/health') {
    return sendJson(res, 200, {
      success: true,
      status: 'ok',
      service: 'Airgo API',
      version: API_VERSION,
      frontend: ['index.html', 'passenger-app.html', 'driver-app.html', 'admin-dashboard.html'],
      backend_files: listBackendFiles(),
      time: new Date().toISOString()
    });
  }

  if (req.method === 'POST' && route === '/auth/login') {
    const body = await readBody(req);
    return sendJson(res, 200, {
      success: true,
      message: 'Demo login successful',
      data: {
        token: 'demo-airgo-token',
        user: { id: 'usr-002', full_name: body.name || 'David Adeyemi', role: body.role || 'passenger' }
      }
    });
  }

  if (req.method === 'POST' && route === '/auth/register') {
    const body = await readBody(req);
    const user = {
      id: `usr-${String(users.length + 1).padStart(3, '0')}`,
      full_name: body.full_name || body.name || 'New Airgo User',
      email: body.email || 'new-user@airgo.local',
      phone: body.phone || '+234 000 000 0000',
      trips: 0,
      rating: 5,
      status: 'active'
    };
    users.push(user);
    return sendJson(res, 201, { success: true, message: 'Demo user registered', data: { user, token: 'demo-airgo-token' } });
  }

  if (req.method === 'GET' && route === '/airports') {
    return sendJson(res, 200, { success: true, data: airports });
  }

  if (req.method === 'GET' && route === '/trips') {
    const airport = url.searchParams.get('airport_code');
    const data = trips.filter(trip => !airport || trip.airport_code === airport).map(publicTrip);
    return sendJson(res, 200, { success: true, data: { trips: data, count: data.length } });
  }

  if (req.method === 'POST' && route === '/trips') {
    const body = await readBody(req);
    const trip = {
      id: `TRP-${4800 + trips.length + 1}`,
      airport_code: body.airport_code || 'LOS',
      airport_name: airports.find(item => item.code === (body.airport_code || 'LOS'))?.name || 'Airport',
      organizer_name: body.organizer_name || 'Demo Passenger',
      route: body.route || `${body.pickup_address || 'Pickup'} to ${body.airport_code || 'LOS'}`,
      pickup_address: body.pickup_address || 'Pickup address',
      departure_date: body.departure_date || new Date().toISOString().slice(0, 10),
      departure_time: body.departure_time || '08:00',
      flight_number: body.flight_number || 'AIRGO1',
      seats_total: Number(body.seats_total || 4),
      seats_taken: 1,
      match_score: 96,
      fare_each: Number(body.fare_each || 4200),
      status: 'matching',
      luggage_type: body.luggage_type || 'checked_1',
      driver_id: body.driver_id || 'drv-001'
    };
    trips.unshift(trip);
    return sendJson(res, 201, { success: true, message: 'Trip created', data: publicTrip(trip) });
  }

  if (req.method === 'GET' && route.startsWith('/trips/')) {
    const id = route.split('/')[2];
    const trip = trips.find(item => item.id === id);
    if (!trip) return sendJson(res, 404, { success: false, message: 'Trip not found' });
    return sendJson(res, 200, { success: true, data: publicTrip(trip) });
  }

  if (req.method === 'POST' && route === '/bookings') {
    const body = await readBody(req);
    const trip = trips.find(item => item.id === (body.trip_id || 'TRP-4829'));
    if (!trip) return sendJson(res, 404, { success: false, message: 'Trip not found' });
    if (trip.seats_taken < trip.seats_total) trip.seats_taken += 1;
    const booking = {
      id: `BKG-${1000 + bookings.length + 1}`,
      trip_id: trip.id,
      user_id: body.user_id || 'usr-002',
      amount_kobo: (trip.fare_each + Math.round(trip.fare_each * 0.1)) * 100,
      status: 'confirmed',
      payment_status: 'success'
    };
    bookings.push(booking);
    return sendJson(res, 201, { success: true, message: 'Booking confirmed in demo mode', data: { booking, trip: publicTrip(trip) } });
  }

  if (req.method === 'GET' && route === '/bookings') {
    return sendJson(res, 200, { success: true, data: bookings });
  }

  if (req.method === 'GET' && route === '/drivers') {
    return sendJson(res, 200, { success: true, data: drivers });
  }

  if (req.method === 'PATCH' && route.startsWith('/drivers/')) {
    const id = route.split('/')[2];
    const body = await readBody(req);
    const driver = drivers.find(item => item.id === id);
    if (!driver) return sendJson(res, 404, { success: false, message: 'Driver not found' });
    Object.assign(driver, body);
    return sendJson(res, 200, { success: true, message: 'Driver updated', data: driver });
  }

  if (req.method === 'GET' && route === '/users') {
    return sendJson(res, 200, { success: true, data: users });
  }

  if (req.method === 'GET' && route === '/notifications') {
    return sendJson(res, 200, { success: true, data: notifications });
  }

  if (req.method === 'GET' && route === '/admin/summary') {
    const completed = trips.filter(trip => trip.status === 'completed').length;
    const revenue = bookings.reduce((total, booking) => total + booking.amount_kobo, 0) / 100;
    return sendJson(res, 200, {
      success: true,
      data: {
        total_users: users.length,
        total_drivers: drivers.length,
        active_trips: trips.filter(trip => trip.status !== 'cancelled').length,
        completed_trips: completed,
        occupancy_rate: 72,
        match_rate: 89,
        revenue_ngn: revenue,
        airports
      }
    });
  }

  if (req.method === 'POST' && route === '/payments/initialize') {
    const body = await readBody(req);
    return sendJson(res, 200, {
      success: true,
      data: {
        authorization_url: 'https://checkout.paystack.com/demo-airgo',
        reference: body.reference || `AIRGO-${Date.now()}`
      }
    });
  }

  if (req.method === 'POST' && route === '/matching/preview') {
    const body = await readBody(req);
    const scored = trips.map(trip => ({
      ...publicTrip(trip),
      score_breakdown: {
        airport: trip.airport_code === (body.airport_code || 'LOS') ? 40 : 20,
        flight_time: 30,
        pickup_distance: 18,
        luggage: trip.luggage_type === (body.luggage_type || trip.luggage_type) ? 10 : 6
      }
    }));
    return sendJson(res, 200, { success: true, data: scored });
  }

  return sendJson(res, 404, { success: false, message: `Route ${req.method} ${route} not found` });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
    if (url.pathname === '/health') {
      return sendJson(res, 200, { success: true, status: 'ok', service: 'Airgo local app', api: `${BASE}/health` });
    }
    if (url.pathname.startsWith(BASE)) {
      return handleApi(req, res, url);
    }
    return serveStatic(req, res);
  } catch (err) {
    return sendJson(res, err.status || 500, { success: false, message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Airgo is live at http://localhost:${PORT}`);
  console.log(`API health: http://localhost:${PORT}${BASE}/health`);
});

module.exports = { server };
