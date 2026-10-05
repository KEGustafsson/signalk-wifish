import dgram from 'node:dgram';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, test, expect, vi } from 'vitest';
import { DeviceTransport, TIMING, candidatesFrom, ifacesFor, type Candidate } from '../src/device';
import { MsgId, VERSION } from '../src/sonar4';
import type { LinkState } from '../src/transport';
import { msg, bottomMsg, unitMsg, announceMsg } from './helpers';

/** An os.networkInterfaces() entry. */
function ni(address: string, netmask: string, internal = false): os.NetworkInterfaceInfo {
  return { address, netmask, family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: null };
}
const v6: os.NetworkInterfaceInfo = { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: null, scopeid: 2 };

describe('candidatesFrom', () => {
  test('prefers 192.x addresses over other non-internal IPv4, skips loopback and IPv6', () => {
    const ifaces = { lo: [ni('127.0.0.1', '255.0.0.0', true)], eth0: [ni('10.1.2.3', '255.255.0.0'), v6], wlan0: [ni('192.168.0.141', '255.255.255.0')] };
    expect(candidatesFrom(ifaces)).toEqual([{ address: '192.168.0.141', netmask: '255.255.255.0' }]);
    expect(candidatesFrom({ lo: ifaces.lo, eth0: ifaces.eth0 })).toEqual([{ address: '10.1.2.3', netmask: '255.255.0.0' }]);
    expect(candidatesFrom({ lo: ifaces.lo, none: undefined })).toEqual([]);
  });

  test('an explicit interface address is the only candidate, once an interface has it', () => {
    const ifaces = { lo: [ni('127.0.0.1', '255.0.0.0', true)], wlan0: [ni('192.168.0.141', '255.255.255.0')], eth0: [ni('10.0.0.5', '255.255.0.0')] };
    expect(candidatesFrom(ifaces, '10.0.0.5')).toEqual([{ address: '10.0.0.5', netmask: '255.255.0.0' }]);
    expect(candidatesFrom(ifaces, '127.0.0.1')).toEqual([{ address: '127.0.0.1', netmask: '255.0.0.0' }]); // loopback too, when asked for
    expect(candidatesFrom(ifaces, '192.168.0.99')).toEqual([]); // not up (yet)
  });
});

describe('ifacesFor', () => {
  const c = (address: string, netmask: string | null): Candidate => ({ address, netmask });

  test('a single candidate is used whatever its subnet', () => {
    expect(ifacesFor([c('10.0.0.5', null)], '192.168.0.1')).toEqual(['10.0.0.5']);
    expect(ifacesFor([], '192.168.0.1')).toEqual([]);
  });

  test('picks the candidate whose subnet contains the sonar, longest prefix first', () => {
    const cs = [c('192.168.1.10', '255.255.255.0'), c('192.168.0.141', '255.255.255.0')];
    expect(ifacesFor(cs, '192.168.0.1')).toEqual(['192.168.0.141']);
    const nested = [c('192.168.0.50', '255.255.0.0'), c('192.168.0.141', '255.255.255.0')];
    expect(ifacesFor(nested, '192.168.0.1')).toEqual(['192.168.0.141', '192.168.0.50']);
  });

  test('overlapping subnets (LAN and sonar both 192.168.0.x/24) are both returned', () => {
    const cs = [c('192.168.0.50', '255.255.255.0'), c('192.168.0.141', '255.255.255.0')];
    expect(ifacesFor(cs, '192.168.0.1')).toEqual(['192.168.0.50', '192.168.0.141']);
  });

  test('when no subnet contains the sonar (/32 Wi-Fi address), every candidate is returned', () => {
    const cs = [c('192.168.1.10', '255.255.255.0'), c('192.168.0.141', '255.255.255.255')];
    expect(ifacesFor(cs, '192.168.0.1')).toEqual(['192.168.1.10', '192.168.0.141']);
  });
});

/**
 * Resolve when `check` returns a value; reject after `ms`. Polls on setImmediate and Date,
 * which the fake timers below leave real, so it works with them installed.
 */
async function waitFor<T>(check: () => T | undefined, ms = 1500): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setImmediate(r));
  }
}
/** Let I/O run for about `ms` (real time). */
const settle = (ms: number) => waitFor(() => undefined, ms).catch(() => {});

/** A udp4 socket bound to `address` on an OS-chosen port. */
function bound(address: string): Promise<dgram.Socket> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(0, address, () => { s.off('error', reject); resolve(s); });
  });
}
const portOf = (s: dgram.Socket) => (s.address() as AddressInfo).port;
/** A UDP port that was free a moment ago (the OS picked it). */
async function freePort(): Promise<number> {
  const s = await bound('127.0.0.1');
  const port = portOf(s);
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const send = (s: dgram.Socket, b: Uint8Array, port: number, address = '127.0.0.1') =>
  new Promise<void>((resolve, reject) => s.send(b, port, address, (e) => (e ? reject(e) : resolve())));

/** An interface list with the given non-internal IPv4 addresses, as os.networkInterfaces() returns it. */
const ifacesWith = (...addresses: string[]) => ({ lo: [ni('127.0.0.1', '255.0.0.0', true)], eth0: addresses.map((a) => ni(a, '255.255.255.0')) });

describe('DeviceTransport on loopback', () => {
  const open: dgram.Socket[] = [];
  let transport: DeviceTransport | null = null;
  afterEach(() => {
    transport?.stop();
    transport = null;
    for (const s of open) { try { s.close(); } catch { /* closed */ } }
    open.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A transport on 127.0.0.1 with recorded links, datagrams and errors. */
  function make(o: { discovery: { group: string; port: number }; keepalive?: boolean; iface?: string; isReady?: () => boolean }) {
    const links: [LinkState, string][] = [];
    const datagrams: Uint8Array[] = [];
    const errors: string[] = [];
    const t = new DeviceTransport({ iface: '127.0.0.1', log: () => {}, error: (m) => errors.push(m), ...o });
    t.on('link', (s, m) => links.push([s, m]));
    t.on('datagram', (b) => datagrams.push(Uint8Array.from(b)));
    transport = t;
    return { t, links, datagrams, errors, states: () => links.map(([s]) => s) };
  }
  const bottomIs = (b: Uint8Array, cm: number) => b[0] === 0x08 && Buffer.from(b).readInt32LE(17) === cm;

  test('searching → connecting → connected on announcement, unit and sonar data; offline after stop()', async () => {
    const sonar = await bound('127.0.0.1'); // the "sonar": sends discovery and data, receives nothing
    const ctrl = await bound('127.0.0.1'); // the sonar's control port: should receive our keepalive
    open.push(sonar, ctrl);
    const port = await freePort();
    const ctrlPort = portOf(ctrl);
    const keepalives: Buffer[] = [];
    ctrl.on('message', (b) => keepalives.push(b));

    const group = '239.255.0.1';
    const { t, links, datagrams, errors, states } = make({ discovery: { group, port }, isReady: () => false });
    t.start();
    t.start(); // no-op
    await waitFor(() => links.find(([s]) => s === 'searching'));

    // The data group:port is the discovery group:port, so no second socket or extra join is needed,
    // and all traffic is unicast to 127.0.0.1: the test does not depend on multicast working on lo.
    await send(sonar, announceMsg(group, port, '127.0.0.1', ctrlPort), port);
    await send(sonar, unitMsg(), port);
    await waitFor(() => links.find(([s]) => s === 'connecting'));
    expect(links.at(-1)![1]).toMatch(/127\.0\.0\.1/);
    // The unit message is replayed to the session at 'connecting', and a keepalive goes out at once.
    expect(datagrams.some((b) => b.length === 52 && b[4] === 63)).toBe(true);
    const ka = await waitFor(() => keepalives[0]);
    expect(ka.length).toBe(37);
    expect(ka.readUInt32LE(0)).toBe(MsgId.KEEPALIVE);
    expect(ka.readUInt32LE(8)).toBe(VERSION);
    expect(ka[16]).toBe(0); // isReady() false

    // A stale-version bottom datagram is passed on but does not mark the link connected.
    await send(sonar, msg(MsgId.BOTTOM, 22, (b) => { b.writeUInt32LE(115, 8); b.writeInt32LE(100, 17); }), port);
    await waitFor(() => (datagrams.some((b) => b[0] === 0x08 && b[8] === 115) ? true : undefined));
    expect(links.at(-1)![0]).toBe('connecting');

    await send(sonar, bottomMsg(1234), port);
    await waitFor(() => links.find(([s]) => s === 'connected'));
    expect(datagrams.some((b) => bottomIs(b, 1234))).toBe(true);
    expect(states()).toEqual(['searching', 'connecting', 'connected']);

    // A repeat of the same announcement changes nothing; a unit message from the device still flows.
    await send(sonar, announceMsg(group, port, '127.0.0.1', ctrlPort), port);
    const before = datagrams.length;
    await send(sonar, unitMsg(), port);
    await waitFor(() => (datagrams.length > before ? true : undefined));
    expect(links).toHaveLength(3);

    t.stop();
    expect(links.at(-1)).toEqual(['offline', 'stopped']);
    t.stop(); // idempotent
    expect(links).toHaveLength(4);
    // After stop, nothing arrives any more and no timer keeps the process alive.
    await send(sonar, bottomMsg(0), port);
    await settle(30);
    expect(links).toHaveLength(4);
    expect(errors.filter((e) => !/join/.test(e))).toEqual([]); // a refused multicast join on lo is the only tolerated problem
  });

  test('sonar data on the discovery socket is ignored before a session, as is a unit message from another address', async () => {
    const sonar = await bound('127.0.0.1');
    open.push(sonar);
    const port = await freePort();
    const { t, links, datagrams, states } = make({ discovery: { group: '239.255.0.2', port }, keepalive: false });
    t.start();
    await waitFor(() => links.find(([s]) => s === 'searching'));
    await send(sonar, bottomMsg(50), port);
    await send(sonar, unitMsg(), port); // the unit alone does not start a session
    await settle(40);
    expect(datagrams).toEqual([]);
    expect(states()).toEqual(['searching']);
    expect(t.canSend).toBe(false);
  });

  test('a separate data port gets its own socket; another sender\'s data and announcements are ignored', async () => {
    const sonar = await bound('127.0.0.1');
    open.push(sonar);
    let other: dgram.Socket | null = null;
    try { other = await bound('127.0.0.2'); open.push(other); } catch { other = null; } // not every OS has 127.0.0.2
    const port = await freePort();
    const dataPort = await freePort();
    const group = '239.255.0.3';
    const { t, links, datagrams, errors, states } = make({ discovery: { group, port }, keepalive: false });
    t.start();
    await waitFor(() => links.find(([s]) => s === 'searching'));
    await send(sonar, announceMsg(group, dataPort, '127.0.0.1', 1), port);
    await send(sonar, unitMsg(), port);
    await waitFor(() => links.find(([s]) => s === 'connecting'));
    await settle(30); // the data socket binds asynchronously
    await send(sonar, bottomMsg(321), dataPort);
    await waitFor(() => links.find(([s]) => s === 'connected'));
    expect(datagrams.some((b) => bottomIs(b, 321))).toBe(true);
    expect(errors.filter((e) => !/join/.test(e))).toEqual([]);
    if (!other) return;
    // A second unit (or this one on a new address): its announcement does not take over, and its
    // data, on the data port or on the discovery port, neither reaches the session nor keeps it alive.
    await send(other, announceMsg(group, dataPort, '127.0.0.2', 1), port);
    await send(other, bottomMsg(999), dataPort);
    await send(other, bottomMsg(998), port);
    await send(sonar, bottomMsg(322), dataPort); // ours still flows, after theirs
    await waitFor(() => (datagrams.some((b) => bottomIs(b, 322)) ? true : undefined));
    expect(datagrams.some((b) => bottomIs(b, 999) || bottomIs(b, 998))).toBe(false);
    expect(states()).toEqual(['searching', 'connecting', 'connected']);
  });

  test('silence: lost after QUIET_MS, then searching again (saying the sonar went offline) after GIVE_UP_MS, and re-acquired', async () => {
    const sonar = await bound('127.0.0.1');
    open.push(sonar);
    const port = await freePort();
    const group = '239.255.0.4';
    // Fake the session tick and its clock only: sockets, setTimeout and setImmediate stay real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    const { t, links, states } = make({ discovery: { group, port }, keepalive: false });
    const handles = () => (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((r) => r === 'UDPWrap').length;
    await settle(30); // sockets of earlier tests finish closing
    const udpBefore = handles();
    t.start();
    await waitFor(() => links.find(([s]) => s === 'searching'));
    const acquire = async (cm: number) => {
      await send(sonar, announceMsg(group, port, '127.0.0.1', 1), port);
      await send(sonar, unitMsg(), port);
      await waitFor(() => (states().at(-1) === 'connecting' ? true : undefined));
      await send(sonar, bottomMsg(cm), port);
      await waitFor(() => (states().at(-1) === 'connected' ? true : undefined));
    };
    await acquire(100);
    vi.advanceTimersByTime(TIMING.QUIET_MS);
    expect(states().at(-1)).toBe('connected'); // not yet
    vi.advanceTimersByTime(1000);
    expect(links.at(-1)).toEqual(['lost', 'Trying to restore connection to the sounder']);
    vi.advanceTimersByTime(TIMING.GIVE_UP_MS - TIMING.QUIET_MS);
    await waitFor(() => (states().at(-1) === 'searching' ? true : undefined));
    // One 'searching', with the reason, not overwritten by the generic search message.
    expect(links.slice(-2)).toEqual([['lost', 'Trying to restore connection to the sounder'], ['searching', 'Sonar offline. Looking for a Wi-Fish / Dragonfly']]);
    await acquire(200);
    expect(states()).toEqual(['searching', 'connecting', 'connected', 'lost', 'searching', 'connecting', 'connected']);
    expect(handles() - udpBefore).toBe(1); // only the discovery socket: nothing leaked across the cycle
    t.stop();
    await settle(20);
    expect(handles()).toBe(udpBefore);
  });

  test('no interface: waiting (not an error), retried until one appears', async () => {
    const port = await freePort();
    const ifaces = vi.spyOn(os, 'networkInterfaces').mockReturnValue({ lo: [ni('127.0.0.1', '255.0.0.0', true)] });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { t, links, errors } = make({ discovery: { group: '239.255.0.5', port }, iface: '' });
    t.start();
    expect(links).toEqual([['searching', 'Waiting for a network interface: the sonar is off or this machine has not joined its Wi-Fi']]);
    vi.advanceTimersByTime(TIMING.RETRY_MS);
    expect(links).toHaveLength(1); // still none: retried quietly
    ifaces.mockReturnValue(ifacesWith('192.0.2.77')); // the Wi-Fi comes up (a join on it fails here: listening anyway)
    vi.advanceTimersByTime(TIMING.RETRY_MS);
    await waitFor(() => links.find(([, m]) => m === 'Looking for a Wi-Fish / Dragonfly'));
    expect(links.some(([s]) => s === 'offline')).toBe(false);
    expect(errors.filter((e) => !/could not join/.test(e))).toEqual([]);
  });

  test('a configured interface address that is not up (sonar off, no DHCP lease) is waited for, not an error', async () => {
    const port = await freePort();
    const ifaces = vi.spyOn(os, 'networkInterfaces').mockReturnValue(ifacesWith('10.0.0.5'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { t, links, errors } = make({ discovery: { group: '239.255.0.6', port }, iface: '192.168.0.141' });
    t.start();
    expect(links).toEqual([['searching', 'Waiting for Wi-Fi interface address 192.168.0.141: the sonar is off or this machine has not joined its Wi-Fi']]);
    vi.advanceTimersByTime(3 * TIMING.RETRY_MS);
    expect(links).toHaveLength(1); // still waiting, quietly
    expect(errors).toEqual([]);
    ifaces.mockReturnValue(ifacesWith('10.0.0.5', '192.168.0.141')); // the sonar is switched on and its DHCP hands out the address
    vi.advanceTimersByTime(TIMING.RETRY_MS);
    await waitFor(() => links.find(([, m]) => m === 'Looking for a Wi-Fish / Dragonfly'));
    expect(links.some(([s]) => s === 'offline')).toBe(false);
  });

  // Windows lets a SO_REUSEADDR socket take over a port another socket holds, so the bind does not fail there.
  test.skipIf(process.platform === 'win32')('a discovery port held by another program: offline with the reason, then retried', async () => {
    const holder = dgram.createSocket('udp4'); // no reuseAddr: the transport cannot share the port
    await new Promise<void>((r) => holder.bind(0, () => r()));
    open.push(holder);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { t, links, errors } = make({ discovery: { group: '239.255.0.7', port: portOf(holder) } });
    t.start();
    await waitFor(() => links.find(([s]) => s === 'offline'));
    expect(links.at(-1)![1]).toMatch(/^discovery socket: .*EADDRINUSE/);
    expect(errors.some((e) => /EADDRINUSE/.test(e))).toBe(true);
    holder.close();
    open.length = 0;
    vi.advanceTimersByTime(TIMING.RETRY_MS);
    await waitFor(() => links.find(([s]) => s === 'searching'));
  });

  test('start, stop and start again rebinds the discovery port at once', async () => {
    const port = await freePort();
    const a = make({ discovery: { group: '239.255.0.8', port }, keepalive: false });
    a.t.start();
    await waitFor(() => a.links.find(([s]) => s === 'searching'));
    a.t.stop();
    const b = make({ discovery: { group: '239.255.0.8', port }, keepalive: false });
    b.t.start();
    await waitFor(() => b.links.find(([s]) => s === 'searching'));
    expect(b.errors).toEqual([]);
  });
});
