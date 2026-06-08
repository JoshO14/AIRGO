(function () {
  const API_BASE = `${window.location.origin}/api/v1`;

  async function airgoFetch(path, options) {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || 'Airgo API request failed');
    return payload;
  }

  function money(value) {
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      maximumFractionDigits: 0
    }).format(value || 0);
  }

  function showLiveBadge(text, ok) {
    let badge = document.getElementById('airgo-live-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'airgo-live-badge';
      badge.style.cssText = [
        'position:fixed',
        'right:14px',
        'bottom:14px',
        'z-index:9999',
        'padding:9px 12px',
        'border-radius:999px',
        'font:600 12px system-ui,-apple-system,Segoe UI,sans-serif',
        'box-shadow:0 10px 30px rgba(0,0,0,.18)',
        'border:1px solid rgba(255,255,255,.25)'
      ].join(';');
      document.body.appendChild(badge);
    }
    badge.textContent = text;
    badge.style.background = ok ? '#1D9E75' : '#E24B4A';
    badge.style.color = '#fff';
  }

  function insertStatusLine(text) {
    const target = document.querySelector('.hero-sub, .top-sub, .dashboard-subtitle, .profile-tag');
    if (!target || document.getElementById('airgo-api-status-line')) return;
    const line = document.createElement('div');
    line.id = 'airgo-api-status-line';
    line.textContent = text;
    line.style.cssText = 'margin-top:8px;font-size:12px;font-weight:700;color:#1D9E75;';
    target.appendChild(line);
  }

  function renderAdminTables(data) {
    const tripsBody = document.getElementById('trips-tbody');
    if (tripsBody && data.trips) {
      tripsBody.innerHTML = data.trips.map(trip => `
        <tr>
          <td style="font-family:'DM Mono',monospace;">#${trip.id}</td>
          <td>${trip.organizer_name}</td>
          <td>${trip.route}</td>
          <td>${trip.departure_date} ${trip.departure_time}</td>
          <td><span class="badge badge-blue">${trip.seats_taken}/${trip.seats_total} riders</span></td>
          <td style="font-family:'DM Mono',monospace;">${money(trip.fare_each)}</td>
          <td><span class="badge ${trip.status === 'matching' ? 'badge-amber' : 'badge-blue'}">${trip.status}</span></td>
          <td><button class="action-btn">View</button></td>
        </tr>
      `).join('');
    }

    const usersBody = document.getElementById('users-tbody');
    if (usersBody && data.users) {
      usersBody.innerHTML = data.users.map(user => `
        <tr>
          <td>${user.full_name}</td>
          <td>${user.email}</td>
          <td>${user.phone}</td>
          <td>${user.trips}</td>
          <td>${user.rating}</td>
          <td><span class="badge ${user.status === 'active' ? 'badge-green' : 'badge-red'}">${user.status}</span></td>
          <td><button class="action-btn">View</button></td>
        </tr>
      `).join('');
    }

    const driversBody = document.getElementById('drivers-tbody');
    if (driversBody && data.drivers) {
      driversBody.innerHTML = data.drivers.map(driver => `
        <tr>
          <td>${driver.full_name}</td>
          <td>${driver.vehicle} - ${driver.plate_number}</td>
          <td><span class="badge badge-blue">${driver.airport_zone}</span></td>
          <td>${driver.trips}</td>
          <td>${driver.rating}</td>
          <td><span class="badge ${driver.kyc_status === 'verified' ? 'badge-green' : 'badge-amber'}">${driver.kyc_status}</span></td>
          <td><span class="badge ${driver.online ? 'badge-green' : 'badge-gray'}">${driver.online ? 'online' : driver.status}</span></td>
          <td><button class="action-btn">Manage</button></td>
        </tr>
      `).join('');
    }
  }

  async function boot() {
    try {
      const health = await airgoFetch('/health');
      window.AirgoAPI = { base: API_BASE, fetch: airgoFetch, health };
      showLiveBadge('Airgo API live', true);
      insertStatusLine(`Connected to ${health.service} with ${health.backend_files.length} backend files linked.`);

      if (location.pathname.includes('admin-dashboard')) {
        const [trips, users, drivers, summary] = await Promise.all([
          airgoFetch('/trips'),
          airgoFetch('/users'),
          airgoFetch('/drivers'),
          airgoFetch('/admin/summary')
        ]);
        renderAdminTables({
          trips: trips.data.trips,
          users: users.data,
          drivers: drivers.data,
          summary: summary.data
        });
      }
    } catch (err) {
      showLiveBadge('API offline', false);
      console.warn(err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
