CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS inventory_pools (
  id BIGSERIAL PRIMARY KEY,
  operator_id TEXT NOT NULL,
  vehicle_group TEXT NOT NULL,
  location TEXT NOT NULL,
  UNIQUE (operator_id, vehicle_group, location)
);

CREATE TABLE IF NOT EXISTS reservations (
  id BIGSERIAL PRIMARY KEY,
  reservation_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  operator_id TEXT NOT NULL,
  external_booking_id TEXT NOT NULL,
  pool_id BIGINT NOT NULL REFERENCES inventory_pools(id),
  vehicle_group TEXT NOT NULL,
  pickup_location TEXT NOT NULL,
  dropoff_location TEXT NOT NULL,
  pickup_at TIMESTAMPTZ NOT NULL,
  dropoff_at TIMESTAMPTZ NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reservations_positive_period CHECK (pickup_at < dropoff_at),
  CONSTRAINT reservations_booking_key UNIQUE (operator_id, external_booking_id),
  CONSTRAINT reservations_no_pool_overlap EXCLUDE USING gist (
    pool_id WITH =,
    tstzrange(pickup_at, dropoff_at, '[)') WITH &&
  )
);