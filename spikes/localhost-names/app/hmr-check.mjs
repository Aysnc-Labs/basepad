// Connects to Next's HMR socket through a URL, edits a page, and waits for a rebuild message.
// Usage: node hmr-check.mjs <ws-url> <page-file>
import { appendFileSync } from 'node:fs';
import WebSocket from 'ws';

const [url, page] = process.argv.slice(2);
// Send the Origin a browser on that page would send; Next checks it on upgrade.
const origin = new URL(url.replace(/^ws/, 'http')).origin;
const ws = new WebSocket(url, { headers: { Origin: origin } });
const fail = setTimeout(() => { console.error('no rebuild message within 30s'); process.exit(1); }, 30000);
ws.on('open', () => {
  console.log('hmr socket open');
  setTimeout(() => appendFileSync(page, '\n// touched\n'), 1000);
});
ws.on('message', (m) => {
  const s = String(m);
  if (process.env.DEBUG) console.log('msg:', s.slice(0, 100));
  if (/built|serverComponentChanges|turbopack-message|"action":"(sync|building)"/.test(s)) {
    console.log('hmr message:', s.slice(0, 120));
    clearTimeout(fail);
    ws.close();
  }
});
ws.on('error', (e) => { console.error(e.message); process.exit(1); });
