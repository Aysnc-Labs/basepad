// An HTTPS dev server for the tests, as Vite serves itself: on PORT, with the certificate basepad
// gives it. It records its port in `tls.json` in its folder, and answers with its folder.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";

const port = Number(process.env.PORT);
const options = {
	cert: readFileSync(process.env.BASEPAD_TLS_CERT),
	key: readFileSync(process.env.BASEPAD_TLS_KEY),
};
createServer(options, (_req, res) => {
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify({ cwd: process.cwd() }));
}).listen(port, "127.0.0.1", () => {
	writeFileSync("tls.json", JSON.stringify({ port }));
	console.log(`listening on ${port}`);
});
