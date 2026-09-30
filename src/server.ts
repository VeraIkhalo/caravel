import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';

type BookingBody = {
  externalBookingId: string;
  operatorId: string;
  vehicleGroup: string;
  pickupLocation: string;
  dropoffLocation: string;
  pickupAt: string;
  dropoffAt: string;
  customer: { name: string; email: string };
};

const tokenOperators: Record<string, string> = {
  'test-token-a': 'operator-a',
  'test-token-b': 'operator-b'
};

const expectedKeys = [
  'externalBookingId', 'operatorId', 'vehicleGroup', 'pickupLocation',
  'dropoffLocation', 'pickupAt', 'dropoffAt', 'customer'
].sort();
const customerKeys = ['email', 'name'];
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function timestampMicros(value: string): bigint | null {
  const match = timestampPattern.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const offsetHours = Number(offsetHourText);
    const offsetRemainder = Number(offsetMinuteText);
    if (offsetHours > 23 || offsetRemainder > 59) return null;
    offsetMinutes = (offsetHours * 60 + offsetRemainder) * (sign === '+' ? 1 : -1);
  }

  const localDate = new Date(0);
  localDate.setUTCFullYear(year, month - 1, day);
  localDate.setUTCHours(hour, minute, second, 0);
  const utcMilliseconds = BigInt(localDate.getTime() - offsetMinutes * 60_000);
  return utcMilliseconds * 1000n + BigInt(fraction.padEnd(6, '0'));
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_REQUEST' });
}

function validateBody(value: unknown): BookingBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Body must be an object.');
  const body = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expectedKeys)) invalid('Body fields are missing or unsupported.');

  for (const key of ['externalBookingId', 'operatorId', 'vehicleGroup', 'pickupLocation', 'dropoffLocation'] as const) {
    if (typeof body[key] !== 'string' || !body[key].trim()) invalid(`${key} must be a nonblank string.`);
  }

  if (!body.customer || typeof body.customer !== 'object' || Array.isArray(body.customer)) invalid('customer must be an object.');
  const customer = body.customer as Record<string, unknown>;
  if (JSON.stringify(Object.keys(customer).sort()) !== JSON.stringify(customerKeys)) invalid('customer must contain only name and email.');
  if (typeof customer.name !== 'string' || !customer.name.trim()) invalid('customer.name must be a nonblank string.');
  if (typeof customer.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) invalid('customer.email is invalid.');

  const pickupMicros = typeof body.pickupAt === 'string' ? timestampMicros(body.pickupAt) : null;
  const dropoffMicros = typeof body.dropoffAt === 'string' ? timestampMicros(body.dropoffAt) : null;
  if (pickupMicros === null) invalid('pickupAt must be a valid timestamp with a timezone.');
  if (dropoffMicros === null) invalid('dropoffAt must be a valid timestamp with a timezone.');
  if (pickupMicros >= dropoffMicros) invalid('pickupAt must precede dropoffAt.');

  if (body.pickupLocation !== 'airport' || body.dropoffLocation !== 'airport') invalid('Only airport locations are supported.');
  if (!['economy', 'compact'].includes(body.vehicleGroup as string)) invalid('Unsupported vehicle group.');
  if (body.operatorId !== 'operator-a' && body.operatorId !== 'operator-b') invalid('Unsupported operator.');
  return body as unknown as BookingBody;
}

function errorReply(code: string, message: string) {
  return { error: { code, message } };
}

async function rollback(client: PoolClient) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Do not mask the original failure if the connection has already closed.
  }
}

export function buildApp(pool = new Pool({ connectionString: process.env.DATABASE_URL })): FastifyInstance {
  const app = Fastify();
  app.addHook('onClose', async () => pool.end());

  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 400) return reply.code(400).send(errorReply('INVALID_REQUEST', 'Request body is invalid.'));
    request.log.error(error);
    return reply.code(500).send(errorReply('INTERNAL_ERROR', 'An unexpected error occurred.'));
  });

  app.post<{ Body: unknown }>('/reservations', async (request, reply) => {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const authorizedOperator = tokenOperators[token];
    if (!authorizedOperator) return reply.code(401).send(errorReply('UNAUTHORIZED', 'A valid bearer token is required.'));

    let body: BookingBody;
    try {
      body = validateBody(request.body);
    } catch (error) {
      const err = error as { code?: string; message?: string };
      return reply.code(400).send(errorReply(err.code ?? 'INVALID_REQUEST', err.message ?? 'Request body is invalid.'));
    }
    if (body.operatorId !== authorizedOperator) return reply.code(403).send(errorReply('FORBIDDEN', 'Token does not authorize this operator.'));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lockIdentity = JSON.stringify([authorizedOperator, body.externalBookingId]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockIdentity]);

      const existing = await client.query<{
        reservation_id: string;
        vehicle_group: string;
        pickup_location: string;
        dropoff_location: string;
        customer_name: string;
        customer_email: string;
        same_pickup: boolean;
        same_dropoff: boolean;
      }>(
        `SELECT reservation_id, vehicle_group, pickup_location, dropoff_location,
                customer_name, customer_email,
                pickup_at = $3::timestamptz AS same_pickup,
                dropoff_at = $4::timestamptz AS same_dropoff
         FROM reservations WHERE operator_id = $1 AND external_booking_id = $2`,
        [authorizedOperator, body.externalBookingId, body.pickupAt, body.dropoffAt]
      );

      if (existing.rowCount) {
        const row = existing.rows[0];
        const samePayload = row.vehicle_group === body.vehicleGroup
          && row.pickup_location === body.pickupLocation
          && row.dropoff_location === body.dropoffLocation
          && row.customer_name === body.customer.name
          && row.customer_email === body.customer.email
          && row.same_pickup && row.same_dropoff;
        await client.query('COMMIT');
        if (!samePayload) return reply.code(409).send(errorReply('IDEMPOTENCY_CONFLICT', 'Booking ID was already used with a different payload.'));
        return reply.code(200).send({ reservationId: row.reservation_id, externalBookingId: body.externalBookingId, operatorId: authorizedOperator });
      }

      const result = await client.query<{ reservation_id: string }>(
        `INSERT INTO reservations (
           operator_id, external_booking_id, pool_id, vehicle_group,
           pickup_location, dropoff_location, pickup_at, dropoff_at,
           customer_name, customer_email
         )
         SELECT $1, $2, id, $3, $4, $5, $6, $7, $8, $9
         FROM inventory_pools
         WHERE operator_id = $1 AND vehicle_group = $3 AND location = $4
         RETURNING reservation_id`,
        [authorizedOperator, body.externalBookingId, body.vehicleGroup, body.pickupLocation,
          body.dropoffLocation, body.pickupAt, body.dropoffAt, body.customer.name, body.customer.email]
      );
      if (!result.rowCount) invalid('No inventory pool matches this request.');
      await client.query('COMMIT');
      return reply.code(201).send({ reservationId: result.rows[0].reservation_id, externalBookingId: body.externalBookingId, operatorId: authorizedOperator });
    } catch (error) {
      await rollback(client);
      if ((error as { code?: string }).code === '23P01') {
        return reply.code(409).send(errorReply('NO_AVAILABILITY', 'No vehicle is available for that period.'));
      }
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send(errorReply('IDEMPOTENCY_CONFLICT', 'Booking ID was already used with a different payload.'));
      }
      if ((error as { code?: string }).code === '23514') {
        return reply.code(400).send(errorReply('INVALID_REQUEST', 'Request body is invalid.'));
      }
      throw error;
    } finally {
      client.release();
    }
  });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = buildApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}