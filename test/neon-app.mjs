// An app's database code, as it runs against Neon in production: Neon's serverless driver over
// WebSocket. Locally, the only differences are the env file basepad writes and plain `ws://`.
// Usage: node neon-app.mjs <env file> <table> <row>
import { neonConfig, Pool } from "@neondatabase/serverless";

const [envFile, table, row] = process.argv.slice(2);
process.loadEnvFile(envFile);

if (process.env.NEON_WS_PROXY) {
	neonConfig.wsProxy = () => process.env.NEON_WS_PROXY;
	neonConfig.useSecureWebSocket = false;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
	await client.query("begin");
	await client.query(`create table if not exists ${table} (name text)`);
	await client.query(`insert into ${table} values ($1)`, [row]);
	const { rows } = await client.query(
		`select current_database() as db, name from ${table} order by name`,
	);
	await client.query("commit");
	console.log(JSON.stringify(rows));
} catch (error) {
	await client.query("rollback");
	throw error;
} finally {
	client.release();
	await pool.end();
}
