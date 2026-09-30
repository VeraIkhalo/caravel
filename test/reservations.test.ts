import 'dotenv/config';
import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/server.js';

const database = new Pool({ connectionString: process.env.DATABASE_URL });
const app = buildApp(database);
const start = '2030-06-10T10:00:00Z';
const end = '2030-06-12T10:00:00Z';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    externalBookingId: 'test-booking',
    operatorId: 'operator-a',
    vehicleGroup: 'economy',
    pickupLocation: 'airport',
    dropoffLocation: 'airport',
    pickupAt: start,
    dropoffAt: end,
    customer: { name: 'Alex Example', email: 'alex@example.com' },
    ...overrides
  };
}

async function post(body: object, token = 'test-token-a'): Promise<{ statusCode: number; json: () => any }> {
  const response = await app.inject({
    method: 'POST',
    url: '/reservations',
    headers: { authorization: `Bearer ${token}` },
    payload: body
  });
  return { statusCode: response.statusCode, json: () => response.json() };
}

async function reservationCount() {
  const result = await database.query('SELECT count(*)::int AS count FROM reservations');
  return result.rows[0].count as number;
}

before(async () => {
  await database.query('SELECT 1');
});

beforeEach(async () => {
  await database.query('TRUNCATE reservations RESTART IDENTITY');
});

after(async () => {
  await app.close();
});

test('two different bookings competing for one vehicle: one succeeds', async () => {
  const [first, second] = await Promise.all([
    post(payload({ externalBookingId: 'compete-1' })),
    post(payload({ externalBookingId: 'compete-2' }))
  ]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [201, 409]);
  assert.equal([first, second].filter((response) => response.json().error?.code === 'NO_AVAILABILITY').length, 1);
  assert.equal(await reservationCount(), 1);
});

test('concurrent identical requests return one original ID', async () => {
  const [first, second] = await Promise.all([post(payload()), post(payload())]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 201]);
  assert.equal(first.json().reservationId, second.json().reservationId);
  assert.equal(await reservationCount(), 1);
});

test('same key concurrently used for different groups conflicts', async () => {
  const [economy, compact] = await Promise.all([
    post(payload()),
    post(payload({ vehicleGroup: 'compact' }))
  ]);
  assert.deepEqual([economy.statusCode, compact.statusCode].sort(), [201, 409]);
  const conflict = economy.statusCode === 409 ? economy : compact;
  assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await reservationCount(), 1);
});

test('operators can use the same booking ID independently', async () => {
  const [a, b] = await Promise.all([
    post(payload(), 'test-token-a'),
    post(payload({ operatorId: 'operator-b' }), 'test-token-b')
  ]);
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  assert.notEqual(a.json().reservationId, b.json().reservationId);
  assert.equal(await reservationCount(), 2);
});

test('adjacent periods are allowed, overlapping periods conflict', async () => {
  assert.equal((await post(payload())).statusCode, 201);
  const contained = payload({ externalBookingId: 'contained', pickupAt: '2030-06-10T12:00:00Z', dropoffAt: '2030-06-11T12:00:00Z' });
  const containedConflict = await post(contained);
  assert.equal(containedConflict.statusCode, 409);
  assert.equal(containedConflict.json().error.code, 'NO_AVAILABILITY');
  const adjacent = payload({ externalBookingId: 'adjacent', pickupAt: end, dropoffAt: '2030-06-13T10:00:00Z' });
  assert.equal((await post(adjacent)).statusCode, 201);
  const overlap = payload({ externalBookingId: 'overlap', pickupAt: '2030-06-11T00:00:00Z', dropoffAt: '2030-06-13T00:00:00Z' });
  const conflict = await post(overlap);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'NO_AVAILABILITY');
  assert.equal(await reservationCount(), 2);
});

test('changed retry conflicts before availability is checked', async () => {
  assert.equal((await post(payload())).statusCode, 201);
  const changed = payload({ pickupAt: '2030-06-10T12:00:00+01:00', dropoffAt: '2030-06-12T10:00:00Z' });
  const response = await post(changed);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await reservationCount(), 1);
});

test('timestamp retries compare instants and invalid auth/input are rejected', async () => {
  assert.equal((await post(payload())).statusCode, 201);
  const equivalent = payload({ pickupAt: '2030-06-10T12:00:00+02:00' });
  assert.equal((await post(equivalent)).statusCode, 200);
  assert.equal((await post(payload(), 'bad-token')).statusCode, 401);
  assert.equal((await post(payload({ operatorId: 'operator-b' }))).statusCode, 403);
  assert.equal((await post(payload({ pickupAt: '2030-06-10T10:00:00' }))).statusCode, 400);
  assert.equal(await reservationCount(), 1);
});