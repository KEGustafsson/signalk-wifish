// UDP transport to a real Wi-Fish / Dragonfly Pro (PROTOCOL.md §1–3).
// Never throws after start(): socket problems become link state 'offline' and a retry.

import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import {
  DISCOVERY, SERVICE_SONAR, MsgId, messageId, parseAnnounce, checkService, buildKeepalive, type Announce,
} from './sonar4';
import type { LinkState, Transport, TransportEvents } from './transport';

export interface DeviceOptions {
  /** Local IPv4 of the interface joined to the sonar's Wi-Fi. Default: like the app, any 192.x address. */
  iface?: string;
  /** Send keepalives and settings. false = passive listener. */
  keepalive?: boolean;
  /** Tells the keepalive whether all required messages have been seen (§3.4). */
  isReady?: () => boolean;
  log?: (msg: string) => void;
}

const RETRY_MS = 5000;
/** The app's receive timeout before it reports a lost connection (a0.d setSoTimeout). */
const QUIET_MS = 3000;
/** After this long without data, drop the session and wait for a fresh announcement. */
const GIVE_UP_MS = 20_000;

/** Monotonic clock, ms. */
const mono = () => globalThis.performance.now();
/** Dotted IPv4 address as an unsigned 32-bit integer. */
const toInt = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) | Number(o), 0) >>> 0;
/** Whether two IPv4 addresses are on the same subnet under `mask`. */
const sameSubnet = (a: string, b: string, mask: string) => ((toInt(a) & toInt(mask)) >>> 0) === ((toInt(b) & toInt(mask)) >>> 0);
/** Whether two announcements name the same data group/port, device and control port. */
const sameService = (a: Announce, b: Announce) => a.group === b.group && a.port === b.port && a.device === b.device && a.ctrlPort === b.ctrlPort;

interface Candidate { address: string; netmask: string | null }

export class DeviceTransport extends EventEmitter<TransportEvents> implements Transport {
  readonly kind = 'device' as const;
  readonly canSend: boolean;
  #opts: DeviceOptions;
  #log: (msg: string) => void;
  #running = false;
  /** null until the first state is reported, so an initial 'offline' is not swallowed. */
  #link: LinkState | null = null;
  #candidates: Candidate[] = [];
  #disc: dgram.Socket | null = null;
  #data: dgram.Socket | null = null;
  #ctrl: dgram.Socket | null = null;
  #service: Announce | null = null;
  #iface: string | null = null;
  /** The sonar's unit message; kept until a session starts, which resets the decoder state. */
  #unit: Uint8Array | null = null;
  #timer: NodeJS.Timeout | null = null;
  #retry: NodeJS.Timeout | null = null;
  #rescan: NodeJS.Timeout | null = null;
  #message = '';
  #lastRx = 0;
  #sessionAt = 0;

  /** Passive (never sends) when `opts.keepalive` is false; nothing is opened until start(). */
  constructor(opts: DeviceOptions = {}) {
    super();
    this.#opts = opts;
    this.canSend = opts.keepalive !== false;
    this.#log = opts.log ?? (() => {});
  }

  /** Current link state; 'offline' before any has been reported. */
  get link(): LinkState { return this.#link ?? 'offline'; }
  /** The sonar announcement the current session uses, or null. */
  get service(): Announce | null { return this.#service; }

  /** Record and emit a link change; a repeat of the same state and message is suppressed. */
  #setLink(s: LinkState, msg: string): void {
    if (s === this.#link && msg === this.#message) return;
    this.#message = msg;
    this.#link = s;
    this.emit('link', s, msg);
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
    this.#setLink('offline', 'stopped');
  }

  /** Send a datagram to the sonar's control port; dropped when passive or sessionless, errors only logged. */
  send(b: Uint8Array): void {
    if (!this.canSend || !this.#ctrl || !this.#service) return;
    try {
      this.#ctrl.send(b, this.#service.ctrlPort, this.#service.device, (e) => e && this.#log(`send failed: ${e.message}`));
    } catch (e) {
      this.#log(`send failed: ${(e as Error).message}`);
    }
  }

  /** Local interfaces to listen on: the configured one, else the non-internal IPv4s (only the 192.x ones when there are any). */
  #candidatesNow(): Candidate[] {
    if (this.#opts.iface) return [{ address: this.#opts.iface, netmask: null }];
    const all = Object.values(os.networkInterfaces()).flat()
      .filter((a): a is os.NetworkInterfaceInfoIPv4 => !!a && a.family === 'IPv4' && !a.internal);
    const c192 = all.filter((a) => a.address.startsWith('192.'));
    return (c192.length ? c192 : all).map((a) => ({ address: a.address, netmask: a.netmask }));
  }

  /** Close everything, report 'offline' with `why`, and reopen after RETRY_MS while running. */
  #scheduleRetry(why: string): void {
    this.#close();
    this.#setLink('offline', why);
    if (!this.#running || this.#retry) return;
    this.#retry = setTimeout(() => { this.#retry = null; if (this.#running) this.#open(); }, RETRY_MS);
  }

  /** Bind the discovery socket, join its group on each candidate interface, then start the interface rescan. */
  #open(): void {
    this.#candidates = this.#candidatesNow();
    if (!this.#candidates.length) return this.#scheduleRetry('No IPv4 network interface; join the sonar Wi-Fi');
    const disc = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.#disc = disc;
    disc.on('error', (e) => this.#scheduleRetry(`discovery socket: ${e.message}`));
    disc.on('message', (b, rinfo) => this.#onDiscovery(b, rinfo.address));
    disc.bind(DISCOVERY.port, () => {
      if (this.#disc !== disc) return; // closed or replaced meanwhile
      let joined = 0;
      for (const c of this.#candidates) {
        try { disc.addMembership(DISCOVERY.group, c.address); joined++; } catch (e) { this.#log(`join ${DISCOVERY.group} on ${c.address}: ${(e as Error).message}`); }
      }
      // 224.0.0.1 is the all-hosts group every interface is already in; if the explicit
      // join is refused (some BSD stacks), keep listening instead of giving up.
      if (!joined) this.#log(`could not join ${DISCOVERY.group} explicitly; listening anyway`);
      this.#log(`listening ${DISCOVERY.group}:${DISCOVERY.port} on ${this.#candidates.map((c) => c.address).join(', ')}`);
      this.#setLink('searching', 'Looking for a Wi-Fish / Dragonfly');
      // The sonar Wi-Fi often comes up after the server: while no session runs,
      // re-read the interfaces and rejoin discovery when they change.
      this.#rescan = setInterval(() => this.#rescanInterfaces(), RETRY_MS);
    });
  }

  /** While no session runs, reopen discovery if the set of local interface addresses changed. */
  #rescanInterfaces(): void {
    if (!this.#running || this.#timer) return; // a session is active
    /** Order-independent key of the candidates' addresses. */
    const key = (cs: Candidate[]) => cs.map((c) => c.address).sort().join(',');
    if (key(this.#candidatesNow()) === key(this.#candidates)) return;
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

  /** Handle a discovery-socket datagram: a sonar announcement, the unit message, or sonar data sent there. */
  #onDiscovery(b: Buffer, sender: string): void {
    const id = messageId(b);
    if (id === MsgId.ANNOUNCE) {
      const s = parseAnnounce(b);
      if (!s || s.service !== SERVICE_SONAR) return;
      const bad = checkService(s, sender);
      if (bad) return this.#log(`ignoring sonar announcement: ${bad}`);
      if (this.#service && sameService(this.#service, s)) return;
      if (this.#service) {
        this.#log('sonar service changed, restarting session');
        this.#stopSession();
        this.#setLink('searching', 'Sonar service changed'); // a new session: forget the old one's state
      }
      this.#service = s;
      this.#maybeStart();
    } else if (id === MsgId.UNIT) {
      this.#unit = Uint8Array.from(b);
      if (this.#timer) this.#rx(b); // during a session: pass it on; before one, #maybeStart replays it
      else this.#maybeStart();
    } else if (id !== null && id >>> 8 === 0x2701) {
      this.#rx(b); // sonar data on the discovery group:port
    }
  }

  /** Pass a datagram on; sonar data (not the unit message) also marks the link alive and restores 'connected'. */
  #rx(b: Uint8Array): void {
    if (messageId(b) !== MsgId.UNIT) {
      this.#lastRx = mono();
      if (this.#link === 'connecting' || this.#link === 'lost') this.#setLink('connected', 'Receiving sonar data');
    }
    this.emit('datagram', b);
  }

  /** Local interface to reach `device`: the only candidate, or the one on its subnet. */
  #ifaceFor(device: string): string | undefined {
    if (this.#candidates.length === 1) return this.#candidates[0].address;
    return this.#candidates.find((c) => c.netmask && sameSubnet(c.address, device, c.netmask))?.address;
  }

  /** Once the announcement and unit message are both in, open the data and control sockets and start ticking. */
  #maybeStart(): void {
    const s = this.#service;
    if (!s || !this.#unit || this.#timer) return;
    const iface = this.#ifaceFor(s.device);
    if (!iface) { this.#log(`no local interface on the subnet of ${s.device}; set the interface option`); return; }
    this.#iface = iface;
    this.#log(`sonar ${s.device}, data ${s.group}:${s.port}, control port ${s.ctrlPort}, via ${iface}`);
    this.#lastRx = this.#sessionAt = mono();
    this.#setLink('connecting', `Connecting to ${s.device}`);
    // 'connecting' resets the session state: hand it the unit message again.
    this.#rx(this.#unit);

    if (s.port === DISCOVERY.port) {
      // Same port as discovery: a second socket would receive every datagram twice.
      if (s.group !== DISCOVERY.group) {
        try { this.#disc!.addMembership(s.group, iface); } catch (e) { return this.#scheduleRetry(`join ${s.group}: ${(e as Error).message}`); }
      }
    } else {
      const data = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.#data = data;
      data.on('error', (e) => this.#scheduleRetry(`data socket: ${e.message}`));
      data.on('message', (b) => this.#rx(b));
      data.bind(s.port, () => {
        if (this.#data !== data) return; // closed or replaced meanwhile
        try { data.addMembership(s.group, iface); } catch (e) { this.#scheduleRetry(`join ${s.group}: ${(e as Error).message}`); }
      });
    }
    if (this.canSend) {
      const ctrl = dgram.createSocket('udp4');
      this.#ctrl = ctrl;
      ctrl.on('error', (e) => this.#scheduleRetry(`control socket: ${e.message}`));
      ctrl.bind(0, iface);
    }
    this.#timer = setInterval(() => this.#tick(), 1000);
    this.#tick();
  }

  /** Each second: rediscover after GIVE_UP_MS of silence, report 'lost' after QUIET_MS, and send a keepalive. */
  #tick(): void {
    const quiet = mono() - this.#lastRx;
    if (quiet > GIVE_UP_MS && mono() - this.#sessionAt > GIVE_UP_MS) {
      this.#log('no sonar data, rejoining discovery');
      this.#setLink('searching', 'Sonar offline. Looking for a Wi-Fish / Dragonfly');
      // Reopen discovery too: a reconnected adapter may have dropped the socket's memberships.
      this.#close();
      this.#open();
      return;
    }
    if (quiet > QUIET_MS && this.#link === 'connected') this.#setLink('lost', 'Trying to restore connection to the sounder');
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
    if (s && this.#iface && s.port === DISCOVERY.port && s.group !== DISCOVERY.group) {
      try { this.#disc?.dropMembership(s.group, this.#iface); } catch { /* not joined */ }
    }
    this.#service = null;
    this.#unit = null;
  }
}
