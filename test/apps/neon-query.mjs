import { neonConfig, Pool } from "@neondatabase/serverless";

const [url, wsProxy, sql] = process.argv.slice(2);
neonConfig.useSecureWebSocket = false;
neonConfig.wsProxy = () => wsProxy;
const pool = new Pool({ connectionString: url });
try {
	const { rows } = await pool.query(sql);
	console.log(JSON.stringify(rows));
} finally {
	await pool.end();
}
