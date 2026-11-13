// A dev server for the up tests. Over HTTP it answers with its folder, PORT and pid; a WebSocket
// upgrade (as a hot-reload client makes) is accepted and sent one text frame with its folder.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT);
const server = createServer((_req, res) => {
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify({ cwd: process.cwd(), port, pid: process.pid }));
});
server.on("upgrade", (req, socket) => {
	const accept = createHash("sha1")
		.update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
		.digest("base64");
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	const payload = Buffer.from(`hello from ${process.cwd()}`);
	socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
});
server.listen(port, "127.0.0.1", () => console.log(`listening on ${port}`));
