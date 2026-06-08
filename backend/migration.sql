-- ═══════════════════════════════════════════════════════════════
--  AIRGO DATABASE SCHEMA  –  Complete Migration
--  Run with: psql -U airgo_user -d airgo_db -f migration.sql
-- ═══════════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- fuzzy text search
CREATE EXTENSION IF NOT EXISTS "postgis";   -- geospatial (optional)

-- ── ENUMS ──────────────────────────────────────────────────────
CREATE TYPE user_status      AS ENUM ('active','suspended','deleted');
CREATE TYPE kyc_status       AS ENUM ('pending','submitted','verified','rejected');
CREATE TYPE trip_status      AS ENUM ('draft','matching','confirmed','active','completed','cancelled');
CREATE TYPE booking_status   AS ENUM ('pending','confirmed','cancelled','completed','refunded');
CREATE TYPE payment_status   AS ENUM ('pending','processing','success','failed','refunded');
CREATE TYPE payment_method   AS ENUM ('paystack','flutterwave','wallet');
CREATE TYPE driver_status    AS ENUM ('pending','active','suspended','inactive');
CREATE TYPE notification_type AS ENUM ('match_found','ride_confirmed','driver_assigned','pickup_soon','trip_started','trip_completed','payment_received','promo','system');
CREATE TYPE message_sender   AS ENUM ('passenger','driver','system');
CREATE TYPE dispute_status   AS ENUM ('open','under_review','resolved','closed');
CREATE TYPE dispute_priority AS ENUM ('low','medium','high','critical');

-- ── AIRPORTS ───────────────────────────────────────────────────
CREATE TABLE airports (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code         VARCHAR(4)  NOT NULL UNIQUE,   -- IATA code e.g. LOS
  name         TEXT        NOT NULL,
  city         TEXT        NOT NULL,
  country      VARCHAR(3)  NOT NULL DEFAULT 'NGA',
  latitude     DECIMAL(9,6),
  longitude    DECIMAL(9,6),
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  terminal_info JSONB      DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── USERS ──────────────────────────────────────────────────────
CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name        TEXT        NOT NULL,
  email            CITEXT      UNIQUE,
  phone            VARCHAR(20) NOT NULL UNIQUE,
  phone_verified   BOOLEAN     NOT NULL DEFAULT FALSE,
  email_verified   BOOLEAN     NOT NULL DEFAULT FALSE,
  password_hash    TEXT,
  avatar_url       TEXT,
  city             TEXT        NOT NULL DEFAULT 'Lagos',
  preferred_airport VARCHAR(4) REFERENCES airports(code),
  rating           DECIMAL(3,2) NOT NULL DEFAULT 5.00,
  total_ratings    INTEGER      NOT NULL DEFAULT 0,
  total_trips      INTEGER      NOT NULL DEFAULT 0,
  total_saved      BIGINT       NOT NULL DEFAULT 0,   -- kobo
  airgo_points     INTEGER      NOT NULL DEFAULT 0,
  is_premium       BOOLEAN      NOT NULL DEFAULT FALSE,
  premium_expires  TIMESTAMPTZ,
  kyc_status       kyc_status   NOT NULL DEFAULT 'pending',
  status           user_status  NOT NULL DEFAULT 'active',
  fcm_token        TEXT,                               -- push notification token
  refresh_token    TEXT,
  otp_code         VARCHAR(6),
  otp_expires      TIMESTAMPTZ,
  last_seen        TIMESTAMPTZ,
  device_info      JSONB        DEFAULT '{}',
  preferences      JSONB        DEFAULT '{"notifications":true,"marketing":false}',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_phone   ON users(phone);
CREATE INDEX idx_users_email   ON users(email);
CREATE INDEX idx_users_status  ON users(status);

-- ── DRIVERS ────────────────────────────────────────────────────
CREATE TABLE drivers (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  full_name         TEXT         NOT NULL,
  phone             VARCHAR(20)  NOT NULL UNIQUE,
  email             CITEXT,
  password_hash     TEXT,
  avatar_url        TEXT,
  vehicle_make      TEXT         NOT NULL,
  vehicle_model     TEXT         NOT NULL,
  vehicle_year      SMALLINT,
  plate_number      VARCHAR(12)  NOT NULL UNIQUE,
  vehicle_color     TEXT,
  vehicle_capacity  SMALLINT     NOT NULL DEFAULT 4,
  airport_zone      VARCHAR(4)   NOT NULL DEFAULT 'LOS' REFERENCES airports(code),
  license_url       TEXT,
  license_expiry    DATE,
  insurance_url     TEXT,
  insurance_expiry  DATE,
  vehicle_photo_url TEXT,
  rating            DECIMAL(3,2) NOT NULL DEFAULT 5.00,
  total_ratings     INTEGER      NOT NULL DEFAULT 0,
  total_trips       INTEGER      NOT NULL DEFAULT 0,
  total_earnings    BIGINT       NOT NULL DEFAULT 0,  -- kobo
  acceptance_rate   DECIMAL(5,2) NOT NULL DEFAULT 100.00,
  kyc_status        kyc_status   NOT NULL DEFAULT 'pending',
  status            driver_status NOT NULL DEFAULT 'pending',
  is_online         BOOLEAN      NOT NULL DEFAULT FALSE,
  current_lat       DECIMAL(9,6),
  current_lng       DECIMAL(9,6),
  last_location_at  TIMESTAMPTZ,
  fcm_token         TEXT,
  refresh_token     TEXT,
  otp_code          VARCHAR(6),
  otp_expires       TIMESTAMPTZ,
  bank_account      JSONB DEFAULT '{}',              -- {account_number, bank_code, account_name}
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_drivers_zone     ON drivers(airport_zone);
CREATE INDEX idx_drivers_status   ON drivers(status, is_online);
CREATE INDEX idx_drivers_location ON drivers(current_lat, current_lng);

-- ── TRIPS ──────────────────────────────────────────────────────
CREATE TABLE trips (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organizer_id        UUID NOT NULL REFERENCES users(id),
  driver_id           UUID REFERENCES drivers(id),
  airport_code        VARCHAR(4) NOT NULL REFERENCES airports(code),
  pickup_address      TEXT       NOT NULL,
  pickup_lat          DECIMAL(9,6),
  pickup_lng          DECIMAL(9,6),
  flight_number       VARCHAR(10),
  airline             TEXT,
  flight_time         TIMESTAMPTZ NOT NULL,
  departure_date      DATE        NOT NULL,
  departure_time      TIME        NOT NULL,
  seats_total         SMALLINT    NOT NULL DEFAULT 4,
  seats_taken         SMALLINT    NOT NULL DEFAULT 1,
  luggage_type        TEXT        NOT NULL DEFAULT 'checked_1',
  preferences         JSONB       DEFAULT '{}',       -- {music, ac, quiet}
  notes               TEXT,
  total_fare          BIGINT,                          -- kobo (set by driver)
  fare_per_person     BIGINT,                          -- kobo (calculated)
  service_fee_rate    DECIMAL(5,2) NOT NULL DEFAULT 10.00,
  status              trip_status  NOT NULL DEFAULT 'matching',
  match_score         DECIMAL(5,2),
  pickup_sequence     JSONB        DEFAULT '[]',       -- ordered list of stops
  actual_departure    TIMESTAMPTZ,
  actual_arrival      TIMESTAMPTZ,
  cancelled_reason    TEXT,
  cancelled_by        UUID,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trips_organizer    ON trips(organizer_id);
CREATE INDEX idx_trips_driver       ON trips(driver_id);
CREATE INDEX idx_trips_airport_date ON trips(airport_code, departure_date);
CREATE INDEX idx_trips_status       ON trips(status);
CREATE INDEX idx_trips_flight_time  ON trips(flight_time);

-- ── BOOKINGS ───────────────────────────────────────────────────
CREATE TABLE bookings (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trip_id          UUID NOT NULL REFERENCES trips(id),
  user_id          UUID NOT NULL REFERENCES users(id),
  pickup_address   TEXT NOT NULL,
  pickup_lat       DECIMAL(9,6),
  pickup_lng       DECIMAL(9,6),
  pickup_order     SMALLINT DEFAULT 1,
  seats_requested  SMALLINT NOT NULL DEFAULT 1,
  amount_kobo      BIGINT   NOT NULL,                  -- fare + service fee
  service_fee_kobo BIGINT   NOT NULL DEFAULT 0,
  payment_status   payment_status NOT NULL DEFAULT 'pending',
  payment_method   payment_method,
  payment_ref      TEXT,
  paystack_ref     TEXT,
  status           booking_status NOT NULL DEFAULT 'pending',
  boarded_at       TIMESTAMPTZ,
  alighted_at      TIMESTAMPTZ,
  cancellation_reason TEXT,
  cancelled_at     TIMESTAMPTZ,
  refund_ref       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(trip_id, user_id)
);

CREATE INDEX idx_bookings_trip   ON bookings(trip_id);
CREATE INDEX idx_bookings_user   ON bookings(user_id);
CREATE INDEX idx_bookings_status ON bookings(status);

-- ── PAYMENTS ───────────────────────────────────────────────────
CREATE TABLE payments (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id       UUID NOT NULL REFERENCES bookings(id),
  user_id          UUID NOT NULL REFERENCES users(id),
  amount_kobo      BIGINT         NOT NULL,
  currency         VARCHAR(3)     NOT NULL DEFAULT 'NGN',
  method           payment_method NOT NULL,
  status           payment_status NOT NULL DEFAULT 'pending',
  provider_ref     TEXT,          -- Paystack/Flutterwave reference
  provider_data    JSONB DEFAULT '{}',
  failure_reason   TEXT,
  initiated_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  refunded_at      TIMESTAMPTZ,
  refund_amount    BIGINT,
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_booking ON payments(booking_id);
CREATE INDEX idx_payments_user    ON payments(user_id);
CREATE INDEX idx_payments_ref     ON payments(provider_ref);

-- ── WALLETS ────────────────────────────────────────────────────
CREATE TABLE wallets (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID UNIQUE REFERENCES users(id),
  driver_id      UUID UNIQUE REFERENCES drivers(id),
  balance_kobo   BIGINT NOT NULL DEFAULT 0,
  ledger         JSONB  NOT NULL DEFAULT '[]',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── DRIVER PAYOUTS ─────────────────────────────────────────────
CREATE TABLE driver_payouts (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id        UUID NOT NULL REFERENCES drivers(id),
  trip_id          UUID REFERENCES trips(id),
  amount_kobo      BIGINT NOT NULL,
  airgo_fee_kobo   BIGINT NOT NULL,
  net_kobo         BIGINT NOT NULL,
  status           payment_status NOT NULL DEFAULT 'pending',
  paystack_ref     TEXT,
  bank_account     JSONB,
  initiated_at     TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── MESSAGES (Group chat per trip) ────────────────────────────
CREATE TABLE messages (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trip_id      UUID NOT NULL REFERENCES trips(id),
  sender_id    UUID NOT NULL,
  sender_type  message_sender NOT NULL,
  content      TEXT NOT NULL,
  is_encrypted BOOLEAN NOT NULL DEFAULT FALSE,
  read_by      JSONB DEFAULT '[]',                    -- array of user_ids
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_trip ON messages(trip_id, created_at);

-- ── RATINGS ────────────────────────────────────────────────────
CREATE TABLE ratings (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trip_id      UUID NOT NULL REFERENCES trips(id),
  rater_id     UUID NOT NULL,
  rated_id     UUID NOT NULL,
  rated_type   TEXT NOT NULL CHECK (rated_type IN ('user','driver')),
  score        SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5),
  tags         TEXT[],
  comment      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(trip_id, rater_id, rated_id)
);

CREATE INDEX idx_ratings_rated ON ratings(rated_id, rated_type);

-- ── NOTIFICATIONS ──────────────────────────────────────────────
CREATE TABLE notifications (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id),
  type         notification_type NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  data         JSONB DEFAULT '{}',
  is_read      BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at      TIMESTAMPTZ,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifs_user ON notifications(user_id, is_read, created_at DESC);

-- ── DISPUTES ───────────────────────────────────────────────────
CREATE TABLE disputes (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trip_id      UUID NOT NULL REFERENCES trips(id),
  booking_id   UUID REFERENCES bookings(id),
  reporter_id  UUID NOT NULL,
  reporter_type TEXT NOT NULL DEFAULT 'passenger',
  against_id   UUID,
  against_type TEXT,
  category     TEXT NOT NULL,
  description  TEXT NOT NULL,
  evidence_urls TEXT[],
  priority     dispute_priority NOT NULL DEFAULT 'medium',
  status       dispute_status   NOT NULL DEFAULT 'open',
  resolution   TEXT,
  resolved_by  UUID,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── PROMO CODES ────────────────────────────────────────────────
CREATE TABLE promo_codes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code            VARCHAR(20) NOT NULL UNIQUE,
  discount_type   TEXT NOT NULL DEFAULT 'fixed',   -- fixed | percent
  discount_value  INTEGER NOT NULL,                -- kobo or percent
  min_fare_kobo   INTEGER DEFAULT 0,
  max_uses        INTEGER,
  used_count      INTEGER NOT NULL DEFAULT 0,
  user_limit      INTEGER DEFAULT 1,               -- per user
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until     TIMESTAMPTZ,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE promo_uses (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  promo_id   UUID NOT NULL REFERENCES promo_codes(id),
  user_id    UUID NOT NULL REFERENCES users(id),
  booking_id UUID REFERENCES bookings(id),
  used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── ADMIN USERS ────────────────────────────────────────────────
CREATE TABLE admins (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name    TEXT         NOT NULL,
  email        CITEXT       NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role         TEXT         NOT NULL DEFAULT 'staff',  -- super_admin | admin | staff
  permissions  TEXT[]       DEFAULT '{}',
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  last_login   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── AUDIT LOG ──────────────────────────────────────────────────
CREATE TABLE audit_log (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id   UUID,
  actor_type TEXT NOT NULL DEFAULT 'user',
  action     TEXT NOT NULL,
  table_name TEXT,
  record_id  UUID,
  old_data   JSONB,
  new_data   JSONB,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_actor  ON audit_log(actor_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_log(action, created_at DESC);

-- ═══════════════════════════════════════════════════════════════
--  STORED FUNCTIONS
-- ═══════════════════════════════════════════════════════════════

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- Apply trigger to all tables with updated_at
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','drivers','trips','bookings','disputes','airports']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_updated_%s BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t, t);
  END LOOP;
END $$;

-- ── MATCHING ENGINE FUNCTION ──────────────────────────────────
-- Scores trips for a given search (higher = better match)
CREATE OR REPLACE FUNCTION find_trip_matches(
  p_airport       VARCHAR(4),
  p_flight_time   TIMESTAMPTZ,
  p_pickup_lat    DECIMAL,
  p_pickup_lng    DECIMAL,
  p_luggage       TEXT,
  p_limit         INT DEFAULT 20
)
RETURNS TABLE (
  trip_id     UUID,
  score       DECIMAL,
  score_breakdown JSONB
) AS $$
DECLARE
  airport_score    DECIMAL;
  time_score       DECIMAL;
  distance_score   DECIMAL;
  luggage_score    DECIMAL;
  mins_diff        DECIMAL;
  dist_km          DECIMAL;
BEGIN
  RETURN QUERY
  SELECT
    t.id AS trip_id,
    ROUND((
      -- 1. Airport match: 40 pts
      CASE WHEN t.airport_code = p_airport THEN 40.0 ELSE 0.0 END +
      -- 2. Flight time proximity: 30 pts (max if ≤30 min, linear decay to 0 at 120 min)
      GREATEST(0, 30.0 - (30.0 * LEAST(1.0,
        ABS(EXTRACT(EPOCH FROM (t.flight_time - p_flight_time)) / 60.0) / 120.0
      ))) +
      -- 3. Pickup distance: 20 pts (max if ≤2km, linear decay to 0 at 20km)
      CASE
        WHEN p_pickup_lat IS NULL OR p_pickup_lng IS NULL THEN 10.0  -- partial score if no coords
        ELSE GREATEST(0, 20.0 - (20.0 * LEAST(1.0,
          (SQRT(POWER((t.pickup_lat - p_pickup_lat) * 111.0, 2) +
                POWER((t.pickup_lng - p_pickup_lng) * 111.0 * COS(RADIANS(p_pickup_lat)), 2))
          ) / 20.0
        )))
      END +
      -- 4. Luggage compatibility: 10 pts
      CASE
        WHEN t.luggage_type = p_luggage     THEN 10.0
        WHEN p_luggage = 'carry_on'          THEN 8.0
        ELSE 5.0
      END
    ), 2) AS score,
    jsonb_build_object(
      'airport',  CASE WHEN t.airport_code = p_airport THEN 40 ELSE 0 END,
      'time',     GREATEST(0, ROUND(30.0 - (30.0 * LEAST(1.0, ABS(EXTRACT(EPOCH FROM (t.flight_time - p_flight_time)) / 60.0) / 120.0)), 0)),
      'distance', 20,
      'luggage',  CASE WHEN t.luggage_type = p_luggage THEN 10 WHEN p_luggage='carry_on' THEN 8 ELSE 5 END
    ) AS score_breakdown
  FROM trips t
  WHERE
    t.status = 'matching'
    AND t.departure_date >= CURRENT_DATE
    AND t.seats_taken < t.seats_total
    AND t.airport_code = p_airport
    AND t.flight_time BETWEEN (p_flight_time - INTERVAL '3 hours') AND (p_flight_time + INTERVAL '3 hours')
  ORDER BY score DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- ── FARE CALCULATOR FUNCTION ──────────────────────────────────
CREATE OR REPLACE FUNCTION calculate_fare(
  p_total_fare_kobo BIGINT,
  p_passengers      INT,
  p_is_premium      BOOLEAN DEFAULT FALSE,
  p_promo_code      TEXT    DEFAULT NULL
)
RETURNS TABLE (
  fare_per_person   BIGINT,
  service_fee       BIGINT,
  total_charge      BIGINT,
  savings           BIGINT,
  fee_rate          DECIMAL
) AS $$
DECLARE
  v_fee_rate  DECIMAL := CASE WHEN p_is_premium THEN 6.0 ELSE 10.0 END;
  v_fare_each BIGINT;
  v_fee       BIGINT;
  v_total     BIGINT;
BEGIN
  v_fare_each := p_total_fare_kobo / p_passengers;
  v_fee       := ROUND(v_fare_each * v_fee_rate / 100.0);
  v_total     := v_fare_each + v_fee;

  RETURN QUERY SELECT
    v_fare_each                                AS fare_per_person,
    v_fee                                      AS service_fee,
    v_total                                    AS total_charge,
    p_total_fare_kobo - v_fare_each            AS savings,
    v_fee_rate                                 AS fee_rate;
END;
$$ LANGUAGE plpgsql;

-- ── UPDATE DRIVER RATING FUNCTION ────────────────────────────
CREATE OR REPLACE FUNCTION recalculate_rating(p_rated_id UUID, p_rated_type TEXT)
RETURNS VOID AS $$
DECLARE v_avg DECIMAL; v_count INT;
BEGIN
  SELECT ROUND(AVG(score)::DECIMAL, 2), COUNT(*) INTO v_avg, v_count
  FROM ratings WHERE rated_id = p_rated_id AND rated_type = p_rated_type;

  IF p_rated_type = 'driver' THEN
    UPDATE drivers SET rating = COALESCE(v_avg, 5.0), total_ratings = v_count WHERE id = p_rated_id;
  ELSE
    UPDATE users   SET rating = COALESCE(v_avg, 5.0), total_ratings = v_count WHERE id = p_rated_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ── SEED AIRPORTS ────────────────────────────────────────────
INSERT INTO airports (code, name, city, country, latitude, longitude) VALUES
  ('LOS', 'Murtala Muhammed International Airport', 'Lagos',         'NGA',  6.5774,  3.3214),
  ('ABV', 'Nnamdi Azikiwe International Airport',   'Abuja',         'NGA',  9.0060, 7.2632),
  ('PHC', 'Port Harcourt International Airport',    'Port Harcourt', 'NGA',  5.0155, 6.9496),
  ('ENU', 'Akanu Ibiam International Airport',      'Enugu',         'NGA',  6.4742, 7.5620),
  ('KAN', 'Mallam Aminu Kano International Airport','Kano',          'NGA', 12.0476, 8.5246)
ON CONFLICT (code) DO NOTHING;

-- ── SEED SUPER ADMIN ─────────────────────────────────────────
-- Password: Admin@Airgo2025 (change immediately!)
INSERT INTO admins (full_name, email, password_hash, role)
VALUES ('Super Admin', 'admin@airgo.ng', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiGc.XHpOi7YxGQy8hGYqx.4NvwG', 'super_admin')
ON CONFLICT (email) DO NOTHING;

-- Indexes for performance
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trips_departure ON trips(departure_date, airport_code, status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bookings_payment ON bookings(payment_status, status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_unread ON messages(trip_id) WHERE created_at > NOW() - INTERVAL '7 days';
