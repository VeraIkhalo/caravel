import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const action = process.argv[2];
if (action !== 'schema' && action !== 'seed') {
  throw new Error('Use: npm run db:schema or npm run db:seed');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const sql = await readFile(resolve('db', `${action}.sql`), 'utf8');
  await pool.query(sql);
  console.log(`${action} completed`);
} finally {
  await pool.end();
}