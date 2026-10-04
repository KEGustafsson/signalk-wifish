// UDP transport to a real Wi-Fish / Dragonfly Pro (PROTOCOL.md §1–3).
// Never throws after start(): socket problems become link state 'offline' and a retry,
// and every socket and timer callback is guarded.

import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import {
  DISCOVERY, SERVICE_SONAR, VERSION, MsgId, messageId, isSonarMessage, parseHeader, isWellFormed, parseAnnounce,
  checkService, buildKeepalive, type Announce,
} from './sonar4';
import { errorMessage } from './util';
import type { LinkState, Transport, TransportEvents } from './transport';

export interface DeviceOptions {
  /** Local IPv4 of the interface joined to the sonar's Wi-Fi. Default: like the app, any 192.x address. */
  iface?: string;
  /** Send keepalives and settings. false = passive listener. */
  keepalive?: boolean;
  /** Tells the keepalive whether all required messages have been seen (§3.4). */
  isReady?: () => boolean;
  /** Debug chatter: what was found, joined and started. */
  log?: (msg: string) => void;
  /** Persistent or serious problems: join and send failures, socket errors, exceptions in handlers. Defaults to `log`. */
  error?: (msg: string) => void;
  /** Discovery group and port; the sonar's 224.0.0.1:5800 by default. Tests point it at a loopback port. */
  discovery?: { group: string; port: number };
}

export const TIMING = Object.freeze({
  /** Reopen after a socket failure, and re-read the interfaces while searching, this often. */
  RETRY_MS: 5000,
  /** The app's receive timeout before it reports a lost connection (a0.d setSoTimeout). */
  QUIET_MS: 3000,
  /** After this long without data, drop the session and wait for a fresh announcement. */
  GIVE_UP_MS: 20_000,
});

/** A local IPv4 address a socket can be bound or joined on; netmask null when unknown. */
export interface Candidate { address: string; netmask: string | null }

/** Monotonic clock, ms. */
const mono = () => globalThis.performance.now();
/** Dotted IPv4 address as an unsigned 32-bit integer. */
const toInt = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) | Number(o), 0) >>> 0;
/** Whether two IPv4 addresses are on the same subnet under `mask`. */
const sameSubnet = (a: string, b: string, mask: string) => ((toInt(a) & toInt(mask)) >>> 0) === ((toInt(b) & toInt(mask)) >>> 0);
/** Number of leading 1 bits in a dotted netmask. */
const prefixLen = (mask: string) => toInt(mask).toString(2).replace(/0+$/, '').length;
/** Whether two announcements name the same data group/port, device and control port. */
const sameService = (a: Announce, b: Announce) => a.group === b.group && a.port === b.port && a.device === b.device && a.ctrlPort === b.ctrlPort;
/** Order-independent key of the candidates' addresses. */
const candidatesKey = (cs: Candidate[]) => cs.map((c) => c.address).sort().join(',');

/**
 * Local interfaces to listen on, from `os.networkInterfaces()`: the configured `iface`
 * alone (none while no interface has that address), else the non-internal IPv4 addresses
 * (only the 192.x ones when there are any, which is how the app picks its interface).
 */
export function candidatesFrom(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, iface?: string): Candidate[] {
  const v4 = Object.values(ifaces).flat()
    .filter((a): a is os.NetworkInterfaceInfoIPv4 => !!a && a.family === 'IPv4');
  if (iface) return v4.filter((a) => a.address === iface).slice(0, 1).map((a) => ({ address: a.address, netmask: a.netmask }));
  const all = v4.filter((a) => !a.internal);
  const c192 = all.filter((a) => a.address.startsWith('192.'));
  return (c192.length ? c192 : all).map((a) => ({ address: a.address, netmask: a.netmask }));
}

/** Candidates whose subnet contains `device`, longest prefix first. */
function subnetMatches(candidates: Candidate[], device: string): Candidate[] {
  return candidates
    .filter((c) => c.netmask !== null && sameSubnet(c.address, device, c.netmask))
    .sort((a, b) => prefixLen(b.netmask!) - prefixLen(a.netmask!));
}

/**
 * Local addresses to join the sonar's data group on to reach `device`, best first.
 * A single candidate is it. Otherwise the candidates whose subnet contains the device,
 * longest prefix first: both are returned when the LAN and the sonar Wi-Fi overlap (the
 * sonar is 192.168.0.1/24 and so is many a home LAN), because only one of them carries
 * the multicast and the netmask can't tell which. When none contains it (the Wi-Fi has
 * the /32 address with a host route that docs/network-setup.md recommends), every
 * candidate is returned, the way the discovery socket joins on all of them.
 */
export function ifacesFor(candidates: Candidate[], device: string): string[] {
  if (candidates.length <= 1) return candidates.map((c) => c.address);
  const matches = subnetMatches(candidates, device);
  return (matches.length ? matches : candidates).map((c) => c.address);
}

/**
 * Address to bind the control (unicast) socket to: the only candidate, else the unique
 * longest-prefix subnet match; undefined when there is none or several tie, so the OS
 * routes to the device itself (bind(0) without an address).
 */
function controlAddress(candidates: Candidate[], device: string): string | undefined {
  if (candidates.length === 1) return candidates[0].address;
  const m = subnetMatches(candidates, device);
  if (!m.length) return undefined;
  if (m.length > 1 && prefixLen(m[0].netmask!) === prefixLen(m[1].netmask!)) return undefined;
  return m[0].address;
}

export class DeviceTransport extends EventEmitter<TransportEvents> implements Transport {
  readonly kind = 'device' as const;
  readonly canSend: boolean;
  #opts: DeviceOptions;
  #log: (msg: string) => void;
  #error: (msg: string) => void;
  #discovery: { group: string; port: number };
  #running = false;
  /** null until the first state is reported, so an initial 'offline' is not swallowed. */
  #link: LinkState | null = null;
  #candidates: Candidate[] = [];
  #disc: dgram.Socket | null = null;
  #data: dgram.Socket | null = null;
  #ctrl: dgram.Socket | null = null;
  /** The sonar we are locked on to (its announcement), or null while searching. */
  #service: Announce | null = null;
  /** Addresses the data group was joined on through the discovery socket (same-port case), to leave again. */
  #joined: string[] = [];
  /** The sonar's unit message and its sender; kept until a session starts, which resets the decoder state. */
  #unit: { b: Uint8Array; from: string } | null = null;
  #timer: NodeJS.Timeout | null = null;
  #retry: NodeJS.Timeout | null = null;
  #rescan: NodeJS.Timeout | null = null;
  #message = '';
  #lastRx = 0;
  /** Last message reported per problem kind, so a persistent one is reported once, not every second. */
  #reported = new Map<string, string>();
  /** Other sonars whose announcements were already reported as ignored during this lock-on. */
  #ignoredDevices = new Set<string>();

  /** Passive (never sends) when `opts.keepalive` is false; nothing is opened until start(). */
  constructor(opts: DeviceOptions = {}) {
    super();
    this.#opts = opts;
    this.canSend = opts.keepalive !== false;
    this.#log = opts.log ?? (() => {});
    this.#error = opts.error ?? this.#log;
    this.#discovery = opts.discovery ?? DISCOVERY;
  }

  /** Record and emit a link change; a repeat of the same state and message is suppressed. */
  #setLink(s: LinkState, msg: string): void {
    if (s === this.#link && msg === this.#message) return;
    this.#message = msg;
    this.#link = s;
    this.emit('link', s, msg);
  }

  /** Report a problem of `kind` through `error`, once per distinct message. */
  #report(kind: string, msg: string): void {
    if (this.#reported.get(kind) === msg) return;
    this.#reported.set(kind, msg);
    this.#error(msg);
  }

  /** Run a socket or timer callback; an exception is reported and swallowed so the transport keeps going. */
  #safely(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.#report(`throw:${what}`, `${what}: ${errorMessage(e)}`);
    }
  }

  /** Open discovery and start looking for the sonar; no-op when already running. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#open();
  }

  /** Cancel any pending retry, close all sockets and report 'offline'. */
  stop(): void {
    this.#running = false;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#close();
    this.#reported.clear();
    this.#setLink('offline', 'stopped');
  }

  /** Send a datagram to the sonar's control port; dropped when passive or sessionless, failures only reported. */
  send(b: Uint8Array): void {
    if (!this.canSend || !this.#ctrl || !this.#service) return;
    const ctrl = this.#ctrl;
    try {
      ctrl.send(b, this.#service.ctrlPort, this.#service.device, (e) => {
        if (e && this.#ctrl === ctrl) this.#report('send', `send to ${this.#service?.device} failed: ${e.message}`);
      });
    } catch (e) {
      this.#report('send', `send to ${this.#service.device} failed: ${errorMessage(e)}`);
    }
  }

  /** Close everything, report 'offline' with `why`, and reopen after RETRY_MS while running. */
  #scheduleRetry(why: string): void {
    this.#close();
    this.#report('socket', why);
    this.#setLink('offline', why);
    if (!this.#running || this.#retry) return;
    this.#retry = setTimeout(() => this.#safely('retry', () => { this.#retry = null; if (this.#running) this.#open(); }), TIMING.RETRY_MS);
  }

  /**
   * Bind the discovery socket, join its group on each candidate interface, report 'searching'
   * with `searching` as the status, then start the interface rescan.
   */
  #open(searching = 'Looking for a Wi-Fish / Dragonfly'): void {
    const { group, port } = this.#discovery;
    const { iface } = this.#opts;
    this.#candidates = candidatesFrom(os.networkInterfaces(), iface);
    if (!this.#candidates.length) {
      return this.#scheduleRetry(iface
        ? `Wi-Fi interface address ${iface} is not on this machine; join the sonar Wi-Fi or correct the setting`
        : 'No IPv4 network interface; join the sonar Wi-Fi');
    }
    const disc = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.#disc = disc;
    disc.on('error', (e) => { if (this.#disc === disc) this.#scheduleRetry(`discovery socket: ${e.message}`); });
    disc.on('message', (b, rinfo) => this.#safely('discovery message', () => this.#onDiscovery(b, rinfo.address)));
    disc.bind(port, () => this.#safely('discovery bind', () => {
      if (this.#disc !== disc) return; // closed or replaced meanwhile
      let joined = 0;
      for (const c of this.#candidates) {
        try { disc.addMembership(group, c.address); joined++; } catch (e) { this.#log(`join ${group} on ${c.address}: ${errorMessage(e)}`); }
      }
      // 224.0.0.1 is the all-hosts group every interface is already in; if the explicit
      // join is refused (some BSD stacks), keep listening instead of giving up.
      if (!joined) this.#report('join', `could not join ${group} on any interface; listening anyway`);
      this.#log(`listening ${group}:${port} on ${this.#candidates.map((c) => c.address).join(', ')}`);
      this.#setLink('searching', searching);
      // The sonar Wi-Fi often comes up after the server: while no session runs,
      // re-read the interfaces and rejoin discovery when they change.
      this.#rescan = setInterval(() => this.#safely('rescan', () => this.#rescanInterfaces()), TIMING.RETRY_MS);
    }));
  }

  /** While no session runs, reopen discovery if the set of local interface addresses changed. */
  #rescanInterfaces(): void {
    if (!this.#running || this.#timer) return; // a session is active
    if (candidatesKey(candidatesFrom(os.networkInterfaces(), this.#opts.iface)) === candidatesKey(this.#candidates)) return;
    this.#log('network interfaces changed, reopening discovery');
    this.#close();
    this.#open();
  }

  /** Stop the rescan and any session, and close the discovery socket. */
  #close(): void {
    if (this.#rescan) clearInterval(this.#rescan);
    this.#rescan = null;
    this.#stopSession();
    try { this.#disc?.close(); } catch { /* already closed */ }
    this.#disc = null;
  }

  /**
   * Handle a discovery-socket datagram: a sonar announcement, the unit message, or sonar
   * data sent there. Once a sonar is chosen we lock on to it: another sonar's announcements
   * and unit messages are ignored until GIVE_UP_MS of silence drops the session; a changed
   * announcement from the same device (its service moved) restarts the session.
   */
  #onDiscovery(b: Buffer, sender: string): void {
    const id = messageId(b);
    if (id === MsgId.ANNOUNCE) {
      const s = parseAnnounce(b);
      if (!s || s.service !== SERVICE_SONAR) return;
      const bad = checkService(s, sender);
      if (bad) return this.#log(`ignoring sonar announcement: ${bad}`);
      if (this.#service && s.device !== this.#service.device) {
        if (!this.#ignoredDevices.has(s.device)) {
          this.#ignoredDevices.add(s.device);
          this.#log(`ignoring a second sonar at ${s.device} while using ${this.#service.device}`);
        }
        return;
      }
      if (this.#service && sameService(this.#service, s)) return;
      if (this.#service) {
        this.#log('sonar service changed, restarting session');
        this.#stopSession();
        this.#setLink('searching', 'Sonar service changed'); // a new session: forget the old one's state
      }
      this.#service = s;
      this.#maybeStart();
    } else if (id === MsgId.UNIT) {
      if (this.#service && sender !== this.#service.device) return; // another sonar's identity
      this.#unit = { b: Uint8Array.from(b), from: sender };
      if (this.#timer) this.#rx(b); // during a session: pass it on; before one, #maybeStart replays it
      else this.#maybeStart();
    } else if (isSonarMessage(id) && this.#timer && sender === this.#service?.device) {
      this.#rx(b); // sonar data on the discovery group:port, only from our sonar while a session runs
    }
  }

  /**
   * Pass a datagram on. A well-formed, current-version 0x2701xx datagram (not the unit
   * message, not a stray or foreign one) also marks the link alive and restores 'connected'.
   */
  #rx(b: Uint8Array): void {
    const h = parseHeader(b);
    if (h && h.version === VERSION && isWellFormed(b, h)) {
      this.#lastRx = mono();
      if (this.#link === 'connecting' || this.#link === 'lost') this.#setLink('connected', 'Receiving sonar data');
    }
    this.emit('datagram', b);
  }

  /** Once the announcement and unit message are both in, open the data and control sockets and start ticking. */
  #maybeStart(): void {
    const s = this.#service;
    if (!s || !this.#unit || this.#unit.from !== s.device || this.#timer) return;
    // Never empty: the discovery socket that got here is only opened with a candidate.
    const ifaces = ifacesFor(this.#candidates, s.device);
    const ctrlAddr = controlAddress(this.#candidates, s.device);
    this.#log(`sonar ${s.device}, data ${s.group}:${s.port}, control port ${s.ctrlPort}, via ${ifaces.join(', ')}${ctrlAddr ? '' : ' (control socket routed by the OS)'}`);
    this.#lastRx = mono();
    this.#setLink('connecting', `Connecting to ${s.device}`);
    // 'connecting' resets the session state: hand it the unit message again.
    this.#rx(this.#unit.b);

    /** Join the data group on every address in `ifaces`; report when none could be joined (unicast data may still arrive). */
    const join = (sock: dgram.Socket, onJoined: (addr: string) => void) => {
      const failed: string[] = [];
      for (const addr of ifaces) {
        try { sock.addMembership(s.group, addr); onJoined(addr); } catch (e) { failed.push(`${addr}: ${errorMessage(e)}`); }
      }
      if (failed.length === ifaces.length) this.#report('join', `could not join ${s.group} (${failed.join('; ')})`);
      else if (failed.length) this.#log(`join ${s.group} failed on ${failed.join('; ')}`);
    };
    if (s.port === this.#discovery.port) {
      // Same port as discovery: a second socket would receive every datagram twice.
      if (s.group !== this.#discovery.group) join(this.#disc!, (addr) => this.#joined.push(addr));
    } else {
      const data = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.#data = data;
      data.on('error', (e) => { if (this.#data === data) this.#scheduleRetry(`data socket: ${e.message}`); });
      // Only our sonar's data: another unit (or this one on a new address) must not keep the session alive.
      data.on('message', (b, rinfo) => this.#safely('data message', () => {
        if (this.#data === data && rinfo.address === s.device) this.#rx(b);
      }));
      data.bind(s.port, () => this.#safely('data bind', () => {
        if (this.#data !== data) return; // closed or replaced meanwhile
        join(data, () => {});
      }));
    }
    if (this.canSend) {
      const ctrl = dgram.createSocket('udp4');
      this.#ctrl = ctrl;
      ctrl.on('error', (e) => { if (this.#ctrl === ctrl) this.#scheduleRetry(`control socket: ${e.message}`); });
      if (ctrlAddr) ctrl.bind(0, ctrlAddr); else ctrl.bind(0);
    }
    this.#timer = setInterval(() => this.#safely('tick', () => this.#tick()), 1000);
    this.#safely('tick', () => this.#tick());
  }

  /** Each second: rediscover after GIVE_UP_MS of silence, report 'lost' after QUIET_MS, and send a keepalive. */
  #tick(): void {
    // lastRx is set when the session starts, so this also bounds a session that never received data.
    const quiet = mono() - this.#lastRx;
    if (quiet > TIMING.GIVE_UP_MS) {
      this.#log('no sonar data, rejoining discovery');
      // Reopen discovery too: a reconnected adapter may have dropped the socket's memberships.
      // The status says the sonar went away, unlike a search that never found one.
      this.#close();
      this.#open('Sonar offline. Looking for a Wi-Fish / Dragonfly');
      return;
    }
    if (quiet > TIMING.QUIET_MS && this.#link === 'connected') this.#setLink('lost', 'Trying to restore connection to the sounder');
    if (this.canSend) this.send(buildKeepalive({ connected: this.#opts.isReady?.() ?? false }));
  }

  /** Close the data and control sockets, leave the data group on the discovery socket, forget the service. */
  #stopSession(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    try { this.#data?.close(); } catch { /* closed */ }
    try { this.#ctrl?.close(); } catch { /* closed */ }
    this.#data = this.#ctrl = null;
    const s = this.#service;
    for (const addr of this.#joined) {
      try { if (s) this.#disc?.dropMembership(s.group, addr); } catch { /* not joined */ }
    }
    this.#joined = [];
    this.#service = null;
    this.#unit = null;
    this.#ignoredDevices.clear();
  }
}
