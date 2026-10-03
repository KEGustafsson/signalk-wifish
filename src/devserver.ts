// Stand-alone server for the web app, without a Signal K server:
//   node dist/devserver.js --demo [--wifish] [--port 3000]
//   node dist/devserver.js --device [--iface 192.168.x.y] [--passive]
//   node dist/devserver.js --replay raw.bin
//   add --data <dir> to keep the web app's display units and vessel settings in <dir>
// Serves public/ at / and /signalk-wifish/, the API at /plugins/signalk-wifish/, and
// prints Signal K deltas with --deltas. There is no authentication: bind to localhost.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { plugin, type PluginConfig } from './plugin';
import { PLUGIN_ID } from './shared/api';

const USAGE = 'Usage: devserver [--demo [--wifish] | --device [--iface ip] [--passive] | --replay file] [--port 3000] [--host 127.0.0.1] [--deltas] [--data dir]';

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
  console.log(USAGE);
  process.exit(0);
}
const port = /^\d+$/.test(values.port) ? Number(values.port) : NaN;
if (!Number.isInteger(port) || port > 65535) {
  console.error(`--port must be a number 0..65535, got '${values.port}'\n${USAGE}`);
  process.exit(2);
}

/** Resolve a command-line path against the directory npm was run from (or the cwd). */
const resolve = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
const cfg: PluginConfig = values.replay
  ? { source: 'replay', replayFile: resolve(values.replay) }
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
  error: (m) => console.error('[wifish]', m),
  getDataDirPath: values.data ? () => resolve(values.data!) : undefined,
});

type Handler = (req: http.IncomingMessage & { path?: string }, res: http.ServerResponse, next: (e?: unknown) => void) => void;
let apiHandler: Handler | null = null;
// No access(): the plugin mounts its catch-all, as under a Signal K without per-route plugin access.
p.registerWithRouter({ use: (fn) => { apiHandler = fn; } });

const publicDir = path.resolve(__dirname, '..', 'public');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.map': 'application/json',
};

/** Serve a file from public/ (index.html for directories), refusing paths that escape it. */
async function serveStatic(urlPath: string, res: http.ServerResponse): Promise<void> {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  } catch {
    res.statusCode = 400; res.end('bad request'); return; // malformed %-escape
  }
  if (rel.includes('\0')) { res.statusCode = 400; res.end('bad request'); return; }
  let file = path.resolve(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep) && file !== publicDir) { res.statusCode = 403; res.end(); return; }
  try {
    if ((await fs.promises.stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const data = await fs.promises.readFile(file);
    res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404; res.end('not found');
  }
}

const server = http.createServer((req, res) => {
  try {
    route(req, res);
  } catch (e) {
    // Never let one odd request (bad absolute-form target, invalid path) stop the server.
    console.error('[wifish]', req.method, req.url, e);
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
    apiHandler(r, res, (e) => {
      // Error details stay in the server log; the client gets a generic answer.
      if (e) console.error('[wifish]', req.method, url.pathname, e);
      if (res.headersSent) { res.end(); return; }
      res.statusCode = e ? 500 : 404;
      res.end(e ? 'internal error' : 'not found');
    });
    return;
  }
  const appRoot = `/${PLUGIN_ID}`;
  void serveStatic(url.pathname.startsWith(appRoot) ? url.pathname.slice(appRoot.length) : url.pathname, res);
}

p.start(cfg);
server.listen(port, values.host, () => {
  const a = server.address();
  log(`web app on http://localhost:${typeof a === 'object' && a ? a.port : port}/  (source: ${cfg.source})`);
});
/** Stop the plugin and the HTTP server, then exit. */
const shutdown = () => { p.stop(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
