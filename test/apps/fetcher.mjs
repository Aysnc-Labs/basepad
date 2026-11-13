// An app that calls another from server-side code: on each request it reads API_URL from the .env
// file in its folder, fetches it, and answers with the URL and what came back (or the error).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.PORT);
const server = createServer(async (_req, res) => {
	const url = /^API_URL=(.*)$/m.exec(readFileSync(".env", "utf8"))?.[1] ?? "";
	let answer;
	try {
		const reply = await fetch(url);
		answer = { url, status: reply.status, body: await reply.json() };
	} catch (error) {
		answer = { url, error: String(error.cause ?? error) };
	}
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(answer));
});
server.listen(port, "127.0.0.1", () => console.log(`listening on ${port}`));
