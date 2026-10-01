// Stand-alone server for the web app, without a Signal K server:
//   node dist/devserver.js --demo [--wifish] [--port 3000]
//   node dist/devserver.js --device [--iface 192.168.x.y] [--passive]
//   node dist/devserver.js --replay raw.bin
//   add --data <dir> to keep the web app's display units in <dir>/display.json
// Serves public/ at / and /signalk-wifish/, the API at /plugins/signalk-wifish/, and
// prints Signal K deltas with --deltas.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { plugin, type PluginConfig } from './plugin';
import { PLUGIN_ID } from './shared/api';

const { values } = parseArgs({
  strict: true,
  options: {
    demo: { type: 'boolean', default: false },
    wifish: { type: 'boolean', default: false },
    device: { type: 'boolean', default: false },
    iface: { type: 'string' },
    passive: { type: 'boolean', default: false },
    replay: { type: 'string' },
    port: { type: 'string', default: '3000' },
    host: { type: 'string', default: '127.0.0.1' },
    deltas: { type: 'boolean', default: false },
    data: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help) {
  console.log('Usage: devserver [--demo [--wifish] | --device [--iface ip] [--passive] | --replay file] [--port 3000] [--host 127.0.0.1] [--deltas] [--data dir]');
  process.exit(0);
}

const cfg: PluginConfig = values.replay
  ? { source: 'replay', replayFile: path.resolve(process.env.INIT_CWD ?? process.cwd(), values.replay) }
  : values.device
    ? { source: 'device', iface: values.iface, keepalive: !values.passive }
    : { source: 'demo', demoModel: values.wifish ? 'wifish' : 'dragonfly' };

/** Console log with a [wifish] prefix. */
const log = (...a: unknown[]) => console.log('[wifish]', ...a);
const p = plugin({
  handleMessage: (_id, delta) => { if (values.deltas) console.log(JSON.stringify(delta)); },
  setPluginStatus: (m) => log('status:', m),
  setPluginError: (m) => log('error:', m),
  debug: (m) => log(m),
  getDataDirPath: values.data ? () => path.resolve(process.env.INIT_CWD ?? process.cwd(), values.data!) : undefined,
});

type Handler = (req: http.IncomingMessage & { path?: string }, res: http.ServerResponse, next: (e?: unknown) => void) => void;
let apiHandler: Handler | null = null;
p.registerWithRouter({ use: (fn) => { apiHandler = fn; } });

const publicDir = path.resolve(__dirname, '..', 'public');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.map': 'application/json',
};

/** Serve a file from public/ (index.html for directories), refusing paths that escape it. */
function serveStatic(urlPath: string, res: http.ServerResponse): void {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  } catch {
    res.statusCode = 400; res.end('bad request'); return; // malformed %-escape
  }
  if (rel.includes('\0')) { res.statusCode = 400; res.end('bad request'); return; }
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep) && file !== publicDir) { res.statusCode = 403; res.end(); return; }
  fs.readFile(fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, 'index.html') : file, (err, data) => {
    if (err) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  try {
    route(req, res);
  } catch {
    // Never let one odd request (bad absolute-form target, invalid path) stop the server.
    if (!res.headersSent) res.statusCode = 400;
    res.end();
  }
});

/** Send plugin paths to the plugin's API handler and everything else, minus the app prefix, to static files. */
function route(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pluginRoot = `/plugins/${PLUGIN_ID}`;
  if (url.pathname.startsWith(pluginRoot + '/') && apiHandler) {
    const r = req as http.IncomingMessage & { path?: string };
    r.path = url.pathname.slice(pluginRoot.length);
    apiHandler(r, res, (e) => { res.statusCode = e ? 500 : 404; res.end(e ? String(e) : 'not found'); });
    return;
  }
  const appRoot = `/${PLUGIN_ID}`;
  serveStatic(url.pathname.startsWith(appRoot) ? url.pathname.slice(appRoot.length) : url.pathname, res);
}

p.start(cfg);
server.listen(Number(values.port), values.host, () => {
  log(`web app on http://localhost:${values.port}/  (source: ${cfg.source})`);
});
/** Stop the plugin and the HTTP server, then exit. */
const shutdown = () => { p.stop(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
