import { createInterface } from "node:readline";
import { neonConfig, Pool } from "@neondatabase/serverless";

const [url, wsProxy] = process.argv.slice(2);
neonConfig.useSecureWebSocket = false;
neonConfig.wsProxy = () => wsProxy;
const pool = new Pool({ connectionString: url, max: 2 });
pool.on("error", () => {});
for await (const sql of createInterface({ input: process.stdin })) {
	try {
		const { rows } = await pool.query(sql);
		console.log(JSON.stringify({ rows }));
	} catch (error) {
		console.log(JSON.stringify({ error: error.message }));
	}
}
await pool.end();
