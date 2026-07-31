import { WebSocket } from 'ws';
const url = process.env.AGENTPORT_RELAY ?? 'wss://agentport.gogakoreli.workers.dev/relay';
const ws = new WebSocket(url, { headers: { Origin: 'https://agentport.gogakoreli.workers.dev' } });
const t = setTimeout(() => { console.log('TIMEOUT after 12s'); process.exit(1); }, 12000);
ws.on('open', () => { console.log('open'); ws.send(JSON.stringify({ t: 'hello', v: 'agentport/1', role: 'client' })); });
ws.on('message', (d) => { console.log('recv:', d.toString().slice(0, 120)); clearTimeout(t); ws.close(); process.exit(0); });
ws.on('error', (e) => { console.log('ERROR:', e.message); process.exit(1); });
ws.on('unexpected-response', (_q, r) => { console.log('HTTP', r.statusCode); process.exit(1); });
