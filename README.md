# Reservation endpoint exercise

## Setup and run

1. Install Node.js 20 or newer and Git.
2. Create a disposable PostgreSQL database on Neon. Do not use a database with data you need; tests clear the reservations table.
3. Copy `.env.example` to `.env` with `Copy-Item .env.example .env`.
4. Replace `DATABASE_URL` in `.env` with the Neon connection string. Keep the SSL query parameter; never commit or share `.env`.
5. From this folder, run `npm install`.
6. Create the tables: `npm run db:schema`.
7. Add the three inventory pools: `npm run db:seed`.
8. Start the API: `npm run dev`.
9. In another terminal, run `npm test` and `npm run typecheck`.

The API and database scripts load `.env` automatically. Docker Compose is optional; use it only if you prefer local PostgreSQL.

Example PowerShell request:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/reservations `
  -Headers @{ Authorization = 'Bearer test-token-a' } `
  -ContentType 'application/json' `
  -Body '{"externalBookingId":"BROKER-1001","operatorId":"operator-a","vehicleGroup":"economy","pickupLocation":"airport","dropoffLocation":"airport","pickupAt":"2030-06-10T10:00:00Z","dropoffAt":"2030-06-12T10:00:00Z","customer":{"name":"Alex Example","email":"alex@example.com"}}'
```

## Concurrency and retries

In `src/server.ts`, each request starts a transaction and calls `pg_advisory_xact_lock` with a hash of the authorized operator and external booking ID. Requests reusing that key wait there; after the first transaction commits, the next request compares the stored booking before checking availability. The `reservations_no_pool_overlap` exclusion constraint in `db/schema.sql` rejects overlapping half-open time ranges for the same pool, including writes from other application processes.

- If PostgreSQL commits but the broker never receives the response, retrying the same key and payload returns `200` with the committed reservation ID.
- If the process stops before commit, PostgreSQL rolls back the open transaction when its connection closes; a retry can create the booking.
- Checking availability before looking up an existing booking would reject an identical retry because its first booking occupies the pool. The concurrent-identical retry test checks this behavior and persisted row count.

## Verification and disclosures

Automated tests cover concurrent competition, concurrent identical requests, concurrent reuse of one key across groups, tenant isolation, adjacent and overlapping periods, changed-payload precedence, timestamp instant equivalence, invalid timezone input, unauthorized token, and operator mismatch. Verified against Neon PostgreSQL: `npm test` passed all 7 tests. `npm run typecheck` passed.

Time spent: 90 minutes (1 hour 30 minutes).

AI tools used: GitHub Copilot for implementation assistance.

Concrete correction: changed the advisory-lock key from a NUL-separated string to a JSON-encoded tuple because PostgreSQL text parameters cannot contain NUL bytes. The concurrent retry and different-group tests passed after the correction.

## Limitations and production improvements

Known limitations:

- Authentication is the exercise's hardcoded token fixture, not production authentication.
- There is no cancellation, modification, rate limiting, or production observability.
- Tests use a disposable database and truncate its reservations table before each case.

Highest-priority production improvements:

1. Replace fixture tokens with production authentication and tenant-scoped authorization.
2. Add versioned database migrations, least-privilege database roles, and managed secret rotation.
3. Add structured monitoring and alerting for database errors, conflict rates, and request latency.