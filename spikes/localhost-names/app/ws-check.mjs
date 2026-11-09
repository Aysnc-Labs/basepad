// Opens a websocket through a URL and prints the echo. Exits non-zero on failure.
import WebSocket from 'ws';

const url = process.argv[2];
const ws = new WebSocket(url);
const timer = setTimeout(() => { console.error('timeout'); process.exit(1); }, 5000);
ws.on('open', () => ws.send('ping'));
ws.on('message', (m) => { console.log(String(m)); clearTimeout(timer); ws.close(); });
ws.on('error', (e) => { console.error(e.message); process.exit(1); });
