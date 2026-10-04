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
  parseBottom, parseEnv, parseError, parsePingResults, parsePingData, parseSystemSettings,
  buildKeepalive, PingAssembler,
} from '../dist/sonar4.js';
import { PATH, centiCToK, depthValues, toDelta, Throttle } from '../dist/signalk.js';
import { CHANNEL, encodeRecord, readRawLog } from '../dist/rawlog.js';

// Lost / give-up timing and the interface choice are shared with the plugin's transport
// (src/device.ts), so the two cannot drift apart.
import { TIMING, candidatesFrom, ifacesFor } from '../dist/device.js';

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
let logFd = null;
if (opts.log) {
  try {
    logFd = fs.openSync(userPath(opts.log), 'a');
  } catch (e) {
    console.error(`--log: ${e.message}`);
    process.exit(1);
  }
}
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
const depthThrottle = new Throttle({ minIntervalMs: 200, heartbeatMs: 5000 });
const tempThrottle = new Throttle({ minIntervalMs: 1000, heartbeatMs: 10_000 });
/** Both depth paths share the depth throttle; a Throttle keeps its last value per path. */
const throttleFor = (p) => (p === PATH.waterTemp ? tempThrottle : depthThrottle);
function emitSk(p, value) {
  if (!skSock || !throttleFor(p).shouldEmit(p, value, mono())) return;
  // One delta per datagram: the Signal K UDP input JSON.parses each datagram whole.
  skSock.send(JSON.stringify(toDelta([{ path: p, value }])), opts.sk.port, opts.sk.host, (e) => e && console.warn(`[sk] ${e.message}`));
}

/**
 * Transducer offset the device applies to the depth it reports (system settings
 * off 60, PROTOCOL.md §6); needed to name the depth paths correctly.
 */
let transducerOffsetCm = 0;
/** Depth paths published so far, so one that stops applying can be cleared. */
let depthPaths = new Set();
/** Depth on the paths the offset makes it mean: belowTransducer, plus belowSurface / belowKeel. */
function emitDepth(cm) {
  const values = depthValues(cm, transducerOffsetCm);
  const now = new Set(values.map((v) => v.path));
  // The offset changed sign (or went to 0): a path that no longer applies would keep its last value.
  for (const p of depthPaths) if (!now.has(p)) emitSk(p, null);
  depthPaths = now;
  for (const v of values) emitSk(v.path, v.value);
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
      // The device reports depth with its transducer offset already applied (PROTOCOL.md §5),
      // so the paths follow that offset. null = bottom lock lost, clears stale depth.
      emitDepth(m.depthCm);
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
    case MsgId.SYS_SETTINGS: {
      const s = parseSystemSettings(b);
      if (s && s.transducerOffsetCm !== transducerOffsetCm) {
        transducerOffsetCm = s.transducerOffsetCm;
        console.log(`[settings] transducer offset ${transducerOffsetCm} cm, depth unit ${s.depthUnit}, simulator ${s.simulator}`);
        emitDepth(null); // retire the paths the old offset implied; the next bottom record refills them
      }
      break;
    }
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
  let capture;
  try {
    capture = fs.readFileSync(userPath(opts.replay));
  } catch (e) {
    console.error(`--replay: ${e.message}`);
    process.exit(1);
  }
  for (const r of readRawLog(capture)) {
    if (r.truncated) { console.warn(`[replay] truncated record at byte ${r.truncated.offset}`); break; }
    if (r.channel === CHANNEL.DATA || messageId(r.msg) > MsgId.UNIT) handleSonar(r.msg, r.channel === CHANNEL.DATA ? 'data' : 'disc');
  }
  summary();
  skSock?.close();
  process.exit(0);
}

// ---------- interface ----------
// The probe keeps its own discovery / data / control sockets instead of using the plugin's
// DeviceTransport on purpose: --log must tag every datagram as a discovery or data record
// (CHANNEL.DISCOVERY / CHANNEL.DATA, which dump-raw and the replay transport rely on), and
// DeviceTransport does not expose which socket a message came in on. The timing constants
// and the interface choice (TIMING, candidatesFrom, ifacesFor) are shared with it.
// Candidates as the plugin picks them (the 192.x addresses when there are any), unless --iface is given.
const candidates = candidatesFrom(os.networkInterfaces(), opts.iface);
if (!candidates.length) {
  console.error(opts.iface ? `No interface has the address ${opts.iface}` : 'No IPv4 network interface; join the sonar Wi-Fi or pass --iface');
  process.exit(1);
}
/** The interface to use for `device`: the best of the plugin's choices. */
const ifaceFor = (device) => ifacesFor(candidates, device)[0];
console.log(`[init] candidate interfaces: ${candidates.map((c) => c.address).join(', ')}`);

function fatal(where) {
  return (e) => { console.error(`[${where}] ${e.message}`); shutdown(1); };
}

// ---------- session ----------
let service = null, unit = null, iface = null, started = false, dataSock = null, ctrlSock = null, kaTimer = null, stale = false;
const sameService = (a, b) => a.group === b.group && a.port === b.port && a.device === b.device && a.ctrlPort === b.ctrlPort;

function stopSession() {
  started = false; stale = false;
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

/** Each second, like the plugin: 'lost' after QUIET_MS of silence, drop the session after GIVE_UP_MS. */
function watchdog() {
  const silence = mono() - lastRx;
  if (silence > TIMING.GIVE_UP_MS) {
    console.warn(`[watchdog] no sonar data for ${TIMING.GIVE_UP_MS / 1000} s, dropping the session; waiting for a new announcement`);
    emitDepth(null);
    stopSession();
    service = null; // the next announcement starts a fresh session
    return;
  }
  const quiet = silence > TIMING.QUIET_MS;
  if (quiet && !stale) {
    console.warn(`[watchdog] no sonar data for ${TIMING.QUIET_MS / 1000} s`);
    emitDepth(null);
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
