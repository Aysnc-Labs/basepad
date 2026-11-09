// A dev server for the names tests: says which checkout it runs in, and echoes over a websocket
// at /ws, as a hot-reload channel would. It listens on $PORT, as basepad's app daemon passes it.
import { createServer } from "node:http";
import { basename } from "node:path";
import { WebSocketServer } from "ws";

const port = Number(process.env.PORT);
const who = basename(process.cwd());
const server = createServer((_req, res) => res.end(`${who}\n`));
new WebSocketServer({ server, path: "/ws" }).on("connection", (socket) => {
	socket.on("message", (message) => socket.send(`${who}: ${message}`));
});
server.listen(port, "127.0.0.1");
