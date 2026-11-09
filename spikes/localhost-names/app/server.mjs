// Two routes plus a websocket echo on one port, so one hostname covers both.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT ?? process.argv[2] ?? 3000);
const label = process.env.LABEL ?? `app:${port}`;
const server = http.createServer((req, res) => {
  if (req.url === '/') return res.end(`${label}: home\n`);
  if (req.url === '/other') return res.end(`${label}: other\n`);
  res.statusCode = 404;
  res.end('not found\n');
});
new WebSocketServer({ server, path: '/ws' }).on('connection', (s) => {
  s.on('message', (m) => s.send(`${label} echo: ${m}`));
});
server.listen(port, '127.0.0.1', () => console.log(`${label} on ${port}`));
