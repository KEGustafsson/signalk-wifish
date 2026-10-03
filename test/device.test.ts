import dgram from 'node:dgram';
import os from 'node:os';
import { afterEach, describe, test, expect } from 'vitest';
import { DeviceTransport, TIMING, candidatesFrom, ifacesFor, type Candidate } from '../src/device';
import { MsgId, VERSION } from '../src/sonar4';
import { msg } from './helpers';

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

  test('an explicit interface address is the only candidate', () => {
    const ifaces = { wlan0: [ni('192.168.0.141', '255.255.255.0')] };
    expect(candidatesFrom(ifaces, '10.0.0.5')).toEqual([{ address: '10.0.0.5', netmask: null }]);
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

/** Resolve when `check` returns a value, polling every few ms; reject after `ms`. */
function waitFor<T>(check: () => T | undefined, ms = 1500): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const v = check();
      if (v !== undefined) { clearInterval(iv); resolve(v); } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timed out')); }
    }, 5);
  });
}

/** A udp4 socket bound to `address` on an OS-chosen port. */
function bound(address: string): Promise<dgram.Socket> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', reject);
    s.bind(0, address, () => { s.off('error', reject); resolve(s); });
  });
}

/** Discovery msg 0 for sonar service 39. */
function announce(group: string, port: number, device: string, ctrlPort: number): Buffer {
  const b = Buffer.alloc(40);
  b.writeUInt32LE(MsgId.ANNOUNCE, 0); b.writeUInt32LE(39, 8);
  b.set(group.split('.').map(Number), 20); b.writeUInt32LE(port, 24);
  b.set(device.split('.').map(Number), 28); b.writeUInt32LE(ctrlPort, 32);
  return b;
}

/** Discovery msg 1. */
function unit(): Buffer {
  const b = Buffer.alloc(52);
  b.writeUInt32LE(MsgId.UNIT, 0); b.writeUInt32LE(63, 4); b.writeUInt32LE(0xc7c035c5, 8); b.write('E70290', 20, 'latin1');
  return b;
}

const send = (s: dgram.Socket, b: Uint8Array, port: number, address = '127.0.0.1') =>
  new Promise<void>((resolve, reject) => s.send(b, port, address, (e) => (e ? reject(e) : resolve())));

describe('DeviceTransport on loopback', () => {
  const open: dgram.Socket[] = [];
  let transport: DeviceTransport | null = null;
  afterEach(() => {
    transport?.stop();
    transport = null;
    for (const s of open) { try { s.close(); } catch { /* closed */ } }
    open.length = 0;
  });

  test('searching → connecting → connected on announcement, unit and sonar data; offline after stop()', async () => {
    const sonar = await bound('127.0.0.1'); // the "sonar": sends discovery and data, receives nothing
    const ctrl = await bound('127.0.0.1'); // the sonar's control port: should receive our keepalive
    open.push(sonar, ctrl);
    const port = (sonar.address() as dgram.AddressInfo).port + 1 + Math.floor(Math.random() * 100); // a free high port for discovery
    const ctrlPort = (ctrl.address() as dgram.AddressInfo).port;
    const keepalives: Buffer[] = [];
    ctrl.on('message', (b) => keepalives.push(b));

    const links: [string, string][] = [];
    const datagrams: Uint8Array[] = [];
    const errors: string[] = [];
    const group = '239.255.0.1';
    transport = new DeviceTransport({
      iface: '127.0.0.1', discovery: { group, port }, isReady: () => false,
      log: () => {}, error: (m) => errors.push(m),
    });
    transport.on('link', (s, m) => links.push([s, m]));
    transport.on('datagram', (b) => datagrams.push(Uint8Array.from(b)));
    transport.start();
    transport.start(); // no-op
    await waitFor(() => links.find(([s]) => s === 'searching'));

    // The data group:port is the discovery group:port, so no second socket or extra join is needed,
    // and all traffic is unicast to 127.0.0.1: the test does not depend on multicast working on lo.
    await send(sonar, announce(group, port, '127.0.0.1', ctrlPort), port);
    await send(sonar, unit(), port);
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

    // A second sonar announcing itself is ignored while we are locked on to the first.
    let other: dgram.Socket | null = null;
    try { other = await bound('127.0.0.2'); open.push(other); } catch { other = null; } // not every OS has 127.0.0.2
    if (other) {
      await send(other, announce(group, port, '127.0.0.2', ctrlPort), port);
      await send(other, unit(), port);
    }

    await send(sonar, msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(1234, 17)), port);
    await waitFor(() => links.find(([s]) => s === 'connected'));
    expect(datagrams.some((b) => b[0] === 0x08 && Buffer.from(b).readInt32LE(17) === 1234)).toBe(true);
    expect(links.map(([s]) => s)).toEqual(['searching', 'connecting', 'connected']);

    // A repeat of the same announcement changes nothing; a unit message from the device still flows.
    await send(sonar, announce(group, port, '127.0.0.1', ctrlPort), port);
    const before = datagrams.length;
    await send(sonar, unit(), port);
    await waitFor(() => (datagrams.length > before ? true : undefined));
    expect(links).toHaveLength(3);

    transport.stop();
    expect(links.at(-1)).toEqual(['offline', 'stopped']);
    transport.stop(); // idempotent
    expect(links).toHaveLength(4);
    // After stop, nothing arrives any more and no timer keeps the process alive.
    await send(sonar, msg(MsgId.BOTTOM, 22), port);
    await new Promise((r) => setTimeout(r, 30));
    expect(links).toHaveLength(4);
    expect(errors.filter((e) => !/join/.test(e))).toEqual([]); // a refused multicast join on lo is the only tolerated problem
    expect(TIMING.QUIET_MS).toBeLessThan(TIMING.GIVE_UP_MS);
  });

  test('sonar data on the discovery socket is ignored before a session, as is a unit message from another address', async () => {
    const sonar = await bound('127.0.0.1');
    open.push(sonar);
    const port = (sonar.address() as dgram.AddressInfo).port + 101 + Math.floor(Math.random() * 100);
    const links: [string, string][] = [];
    const datagrams: Uint8Array[] = [];
    transport = new DeviceTransport({ iface: '127.0.0.1', discovery: { group: '239.255.0.2', port }, keepalive: false, log: () => {} });
    transport.on('link', (s, m) => links.push([s, m]));
    transport.on('datagram', (b) => datagrams.push(Uint8Array.from(b)));
    transport.start();
    await waitFor(() => links.find(([s]) => s === 'searching'));
    await send(sonar, msg(MsgId.BOTTOM, 22, (b) => b.writeInt32LE(50, 17)), port);
    await send(sonar, unit(), port); // the unit alone does not start a session
    await new Promise((r) => setTimeout(r, 40));
    expect(datagrams).toEqual([]);
    expect(links.map(([s]) => s)).toEqual(['searching']);
    expect(transport.canSend).toBe(false);
  });
});
