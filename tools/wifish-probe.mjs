#!/usr/bin/env node
// Wi-Fish "Sonar4" probe — discovery, keepalive, depth/temp decode, raw logging.
// Spec: docs/PROTOCOL.md. Decoding lives in src/sonar4.ts (run `npm run build:server` first).

import dgram from 'node:dgram';
import os from 'node:os';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import {
  VERSION, DISCOVERY, SERVICE_SONAR, MsgId, REQUIRED,
  messageId, parseHeader, isWellFormed, parseAnnounce, checkService, parseUnit,
  parseBottom, parseEnv, parseError, parsePingResults, parsePingData, buildKeepalive, PingAssembler,
} from '../dist/sonar4.js';
import { PATH, cmToM, centiCToK, toDelta, Throttle } from '../dist/signalk.js';
import { CHANNEL, encodeRecord, readRawLog } from '../dist/rawlog.js';

const USAGE = `Usage: wifish-probe [options]
  --iface <ipv4>     local WLAN address (default: the 192.x address on the sonar's subnet)
  --log <file>       append raw capture (read with dump-raw.mjs)
  --sk <host:port>   send Signal K deltas over UDP
  --no-keepalive     passive: never send anything to the device
  --replay <file>    decode a raw capture instead of listening (no sockets)
  -h, --help`;

// ---------- options ----------
let opts;
try {
  const { values } = parseArgs({
    strict: true, allowPositionals: false,
    options: {
      iface: { type: 'string' }, log: { type: 'string' }, sk: { type: 'string' }, replay: { type: 'string' },
      'no-keepalive': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) { console.log(USAGE); process.exit(0); }
  if (values.iface !== undefined && !net.isIPv4(values.iface)) throw new Error(`--iface: not an IPv4 address: ${values.iface}`);
  let sk = null;
  if (values.sk !== undefined) {
    const m = /^([^:]+):(\d{1,5})$/.exec(values.sk);
    const port = m ? Number(m[2]) : 0;
    if (!m || port < 1 || port > 65535) throw new Error(`--sk: expected host:port, got ${values.sk}`);
    sk = { host: m[1], port };
  }
  if (values.replay && sk) throw new Error('--replay does not send Signal K output; drop --sk');
  opts = { ...values, sk, keepalive: !values['no-keepalive'] };
} catch (e) {
  console.error(`${e.message}\n\n${USAGE}`);
  process.exit(2);
}
// Monotonic ms for throttling/watchdog: the Jetson's wall clock may step when NTP/GPS sets it.
const mono = () => performance.now();
// npm run executes from the package root; resolve paths against where the user ran it.
const userPath = (p) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);

// ---------- outputs ----------
let logFd = opts.log ? fs.openSync(userPath(opts.log), 'a') : null;
function logRaw(channel, buf) {
  if (logFd === null) return;
  try {
    fs.writeSync(logFd, encodeRecord(channel, buf));
  } catch (e) {
    console.error(`[log] write failed, raw logging disabled: ${e.message}`);
    logFd = null;
  }
}

const skSock = opts.sk ? dgram.createSocket('udp4') : null;
skSock?.on('error', (e) => console.warn(`[sk] ${e.message}`));
// Depth: on change, max 5 Hz, 5 s heartbeat. Temperature: max 1 Hz, 10 s heartbeat. null (no data) passes at once.
const throttles = { [PATH.depth]: new Throttle({ minIntervalMs: 200, heartbeatMs: 5000 }), [PATH.waterTemp]: new Throttle({ minIntervalMs: 1000, heartbeatMs: 10_000 }) };
function emitSk(p, value) {
  if (!skSock || !throttles[p].shouldEmit(p, value, mono())) return;
  // One delta per datagram: the Signal K UDP input JSON.parses each datagram whole.
  skSock.send(JSON.stringify(toDelta([{ path: p, value }])), opts.sk.port, opts.sk.host, (e) => e && console.warn(`[sk] ${e.message}`));
}

// ---------- sonar4 decode ----------
const seen = new Map(); // message id -> count (well-formed messages only)
const warned = new Set();
const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.warn(msg); } };
const nameOf = (id) => typeof id === 'string' ? id : Object.keys(MsgId).find((k) => MsgId[k] === id) ?? `0x${id.toString(16)}`;
const asm = new PingAssembler();

/** Count a completed column and log every 50th. */
function logColumn(col) {
  if (!col || columns++ % 50 !== 0) return;
  const r = col.results;
  const max = col.samples.reduce((a, v) => (v > a ? v : a), 0);
  console.log(`[ping] seq=${col.seq} n=${col.samples.length} filled=${col.filled} ch=${r?.channel ?? '?'} range=${r ? r.rangeStartCm + '..' + r.rangeEndCm : '?'} max=${max} dropped=${asm.dropped}`);
}
let tempCentiC, lastRx = 0, columns = 0;

function handleSonar(b, via) {
  const h = parseHeader(b);
  if (!h) return;
  if (h.version !== VERSION) return warnOnce(`ver${h.id}`, `[warn] ${nameOf(h.id)} version ${h.version} != ${VERSION}, ignored`);
  if (!isWellFormed(b, h)) return warnOnce(`len${h.id}`, `[warn] ${nameOf(h.id)} malformed: ${b.length} bytes, header says ${h.length}; dropping these`);
  lastRx = mono();
  if (!seen.has(h.id)) console.log(`[${via}] first ${nameOf(h.id)} len=${h.length}`);
  seen.set(h.id, (seen.get(h.id) ?? 0) + 1);

  switch (h.id) {
    case MsgId.BOTTOM: {
      const m = parseBottom(b);
      console.log(`[depth] ${m.depthCm === null ? '--' : (m.depthCm / 100).toFixed(2) + ' m'}  q=${m.quality} ch=${m.channel}`);
      // ❓ Assumed below-transducer; unconfirmed (PROTOCOL.md §5). null = bottom lock lost, clears stale depth.
      emitSk(PATH.depth, m.depthCm === null ? null : cmToM(m.depthCm));
      break;
    }
    case MsgId.ENV: {
      const t = parseEnv(b).waterTempCentiC;
      if (t !== tempCentiC) { tempCentiC = t; console.log(`[env] water ${t === null ? '--' : t / 100} °C`); }
      emitSk(PATH.waterTemp, t === null ? null : centiCToK(t));
      break;
    }
    case MsgId.ERROR:
      console.log(`[error] flags=0x${parseError(b).flags.toString(16)}`);
      break;
    // A column completes on whichever of its data and results arrives last.
    case MsgId.PING_RESULTS:
      logColumn(asm.addResults(parsePingResults(b), mono()));
      break;
    case MsgId.PING_DATA:
      logColumn(asm.push(parsePingData(b), mono()));
      break;
  }
}

function summary() {
  console.log('\n[summary] message counts:');
  for (const [id, n] of seen) console.log(`  ${nameOf(id)}: ${n}`);
  console.log(`  columns: ${columns}, dropped pings: ${asm.dropped}`);
}

// ---------- replay ----------
if (opts.replay) {
  for (const r of readRawLog(fs.readFileSync(userPath(opts.replay)))) {
    if (r.truncated) { console.warn(`[replay] truncated record at byte ${r.truncated.offset}`); break; }
    if (r.channel === CHANNEL.DATA || messageId(r.msg) > MsgId.UNIT) handleSonar(r.msg, r.channel === CHANNEL.DATA ? 'data' : 'disc');
  }
  summary();
  skSock?.close();
  process.exit(0);
}

// ---------- interface ----------
// Candidates as the app picks them (IPv4 starting with 192.), unless --iface is given.
const candidates = opts.iface
  ? [{ address: opts.iface, netmask: null }]
  : Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal && a.address.startsWith('192.'));
if (!candidates.length) { console.error('No 192.x interface; pass --iface'); process.exit(1); }

const toInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) | Number(o), 0) >>> 0;
const sameSubnet = (a, b, mask) => ((toInt(a) & toInt(mask)) >>> 0) === ((toInt(b) & toInt(mask)) >>> 0);
function ifaceFor(device) {
  if (candidates.length === 1) return candidates[0].address;
  return candidates.find((c) => sameSubnet(c.address, device, c.netmask))?.address;
}
console.log(`[init] candidate interfaces: ${candidates.map((c) => c.address).join(', ')}`);

function fatal(where) {
  return (e) => { console.error(`[${where}] ${e.message}`); shutdown(1); };
}

// ---------- session ----------
let service = null, unit = null, iface = null, started = false, dataSock = null, ctrlSock = null, kaTimer = null, stale = false;
const sameService = (a, b) => a.group === b.group && a.port === b.port && a.device === b.device && a.ctrlPort === b.ctrlPort;

function stopSession() {
  started = false;
  clearInterval(kaTimer); kaTimer = null;
  dataSock?.close(); dataSock = null;
  ctrlSock?.close(); ctrlSock = null;
  if (service && iface && service.port === DISCOVERY.port && service.group !== DISCOVERY.group) {
    try { disc.dropMembership(service.group, iface); } catch {}
  }
  for (const id of REQUIRED) seen.delete(id); // go back to "connecting" on the next session
}

function maybeStart() {
  if (!service || !unit || started) return;
  started = true;
  iface = ifaceFor(service.device);
  if (!iface) { console.error(`[init] no local interface on the subnet of ${service.device}; pass --iface`); return shutdown(1); }
  console.log(`[init] using interface ${iface}`);
  lastRx = mono();

  if (service.port === DISCOVERY.port) {
    // Same port as discovery: a second socket would receive (and decode) every datagram twice.
    // Data on 224.0.0.1 itself: already joined for discovery.
    if (service.group !== DISCOVERY.group) try { disc.addMembership(service.group, iface); } catch (e) { return fatal('data')(e); }
    console.log(`[data] joined ${service.group}:${service.port} on the discovery socket`);
  } else {
    dataSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    dataSock.on('error', fatal('data'));
    dataSock.on('message', (b) => guard(() => { logRaw(CHANNEL.DATA, b); handleSonar(b, 'data'); }));
    dataSock.bind(service.port, () => guard(() => {
      dataSock.addMembership(service.group, iface);
      console.log(`[data] joined ${service.group}:${service.port}`);
    }, fatal('data')));
  }

  if (!opts.keepalive) { console.log('[ka] keepalive disabled'); kaTimer = setInterval(watchdog, 1000); return; }
  ctrlSock = dgram.createSocket('udp4');
  ctrlSock.on('error', fatal('ka'));
  ctrlSock.bind(0, iface, () => { kaTimer = setInterval(tick, 1000); tick(); });
}

function tick() {
  watchdog();
  const k = buildKeepalive({ connected: REQUIRED.every((id) => seen.has(id)) });
  ctrlSock?.send(k, service.ctrlPort, service.device, (e) => e && warnOnce(`ka:${e.code}`, `[ka] send failed: ${e.message}`));
}

function watchdog() {
  const quiet = mono() - lastRx > 5000;
  if (quiet && !stale) {
    console.warn('[watchdog] no sonar data for 5 s');
    emitSk(PATH.depth, null);
  } else if (!quiet && stale) {
    console.log('[watchdog] data flowing again');
  }
  stale = quiet;
}

// Never let one bad datagram take the process down.
function guard(fn, onError = (e) => warnOnce(`exc:${e.message}`, `[warn] ${e.stack}`)) {
  try { fn(); } catch (e) { onError(e); }
}

// ---------- discovery ----------
const disc = dgram.createSocket({ type: 'udp4', reuseAddr: true });
disc.on('error', fatal('disc'));
disc.on('message', (b, rinfo) => guard(() => {
  logRaw(CHANNEL.DISCOVERY, b);
  const id = messageId(b);
  if (id === MsgId.ANNOUNCE) {
    const s = parseAnnounce(b);
    if (!s) return;
    if (s.service !== SERVICE_SONAR) {
      if (!seen.has(`svc${s.service}`) && seen.size < 64) {
        seen.set(`svc${s.service}`, 1);
        console.log(`[disc] service ${s.service} port=${s.port} ${b.toString('hex', 16, 36)}`);
      }
      return;
    }
    const bad = checkService(s, rinfo.address);
    if (bad) return warnOnce(`svc:${bad}`, `[disc] ignoring sonar announcement: ${bad}`);
    if (service && sameService(service, s)) return;
    if (service) { console.log('[disc] sonar service changed, restarting session', s); stopSession(); }
    else console.log('[disc] sonar service', s);
    service = s;
    maybeStart();
  } else if (id === MsgId.UNIT) {
    const u = parseUnit(b);
    if (u && !unit) { unit = u; console.log('[disc] unit', unit); maybeStart(); }
  } else if (id !== null) {
    handleSonar(b, 'disc');
  }
}));
disc.bind(DISCOVERY.port, () => guard(() => {
  // 224.0.0.1 is link-local: join it on every candidate so the announcement tells us which one is the sonar's.
  let joined = 0;
  for (const c of candidates) {
    try { disc.addMembership(DISCOVERY.group, c.address); joined++; } catch (e) { console.warn(`[disc] join on ${c.address}: ${e.message}`); }
  }
  if (!joined) throw new Error('could not join the discovery group on any interface');
  console.log(`[disc] listening ${DISCOVERY.group}:${DISCOVERY.port}`);
}, fatal('disc')));

// ---------- shutdown ----------
function shutdown(code = 0) {
  summary();
  clearInterval(kaTimer);
  for (const s of [disc, dataSock, ctrlSock, skSock]) try { s?.close(); } catch {}
  if (logFd !== null) fs.closeSync(logFd);
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
