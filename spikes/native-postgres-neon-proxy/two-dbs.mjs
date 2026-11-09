// Queries two databases through Neon's proxy with the serverless driver's Pool.
// Usage: PROXY=localhost:4444 SECURE=0 node two-dbs.mjs
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

const proxy = process.env.PROXY ?? 'localhost:4444';
neonConfig.webSocketConstructor = ws;
neonConfig.useSecureWebSocket = process.env.SECURE === '1';
if (process.env.PIPELINE === '0') neonConfig.pipelineConnect = false;
neonConfig.wsProxy = () => `${proxy}/v2`;

const port = process.env.PGPORT ?? '5432';
for (const db of ['alpha', 'beta']) {
  const pool = new Pool({ connectionString: `postgres://postgres:postgres@localhost:${port}/${db}${process.env.PGQUERY ?? ""}` });
  const { rows } = await pool.query('select current_database() as db, name from t');
  console.log(JSON.stringify(rows));
  await pool.end();
}
