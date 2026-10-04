import { describe, test, expect } from 'vitest';
import { Sonar4Session, MAX_SENDS, RESEND_MS, type SessionColumn } from '../src/session';
import { MsgId, CS, SS, parseChannelSettings, parseSystemSettings } from '../src/sonar4';
import { msg, segment, results, channelSettings, systemSettings, bottomMsg, envMsg, unitMsg } from './helpers';

function columns(s: Sonar4Session): SessionColumn[] {
  const out: SessionColumn[] = [];
  s.on('column', (c) => out.push(c));
  return out;
}

describe('Sonar4Session', () => {
  test('pairs a column with its ping results and uses the auto range', () => {
    const s = new Sonar4Session();
    const cols = columns(s);
    s.handle(channelSettings(7, 1));
    s.handle(results(4, 1, 100, 1500));
    s.handle(segment({ seq: 4, seg: 0, count: 1, total: 3, offset: 0, data: [1, 2, 3], setting: 7 }));
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ channel: 1, configIndex: 7, startCm: 100, endCm: 1500 });
    expect(s.configIndex).toEqual([null, 7]);
  });

  test('uses the manual range from the channel settings when auto is off', () => {
    const s = new Sonar4Session();
    const cols = columns(s);
    s.handle(channelSettings(7, 1, { rangeAuto: 0, shallow: 200, deep: 900 }));
    s.handle(results(4, 0, 0, 1500));
    s.handle(segment({ seq: 4, seg: 0, count: 1, total: 2, offset: 0, data: [1, 2], setting: 7 }));
    expect(cols[0]).toMatchObject({ channel: 0, startCm: 200, endCm: 900 });
  });

  test('skips columns of a configuration held as disabled or never received, and columns without results', () => {
    const s = new Sonar4Session();
    const cols = columns(s);
    s.handle(channelSettings(7, 1, { enabled: 0 }));
    s.handle(channelSettings(1, 1));
    s.handle(results(4, 0, 0, 1500));
    s.handle(segment({ seq: 4, seg: 0, count: 1, total: 2, offset: 0, data: [1, 2], setting: 7 }));
    s.handle(segment({ seq: 5, seg: 0, count: 1, total: 2, offset: 0, data: [1, 2], setting: 1 }));
    s.handle(results(6, 0, 0, 1500));
    s.handle(segment({ seq: 6, seg: 0, count: 1, total: 2, offset: 0, data: [1, 2], setting: 20 }));
    expect(cols).toHaveLength(0);
  });

  test('emits a column when its results come after the data', () => {
    const s = new Sonar4Session();
    const cols = columns(s);
    s.handle(channelSettings(0, 1));
    s.handle(segment({ seq: 3, seg: 0, count: 1, total: 2, offset: 0, data: [1, 2], setting: 0 }));
    expect(cols).toHaveLength(0);
    s.handle(results(3, 0, 0, 800));
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ channel: 0, endCm: 800 });
  });

  test('reset forgets results, unit and readings from the previous connection', () => {
    const s = new Sonar4Session();
    const cols = columns(s);
    s.handle(unitMsg(67));
    s.handle(envMsg(1530));
    s.handle(results(1, 1, 0, 5000));
    s.handle(msg(MsgId.SYS_STATUS, 1063));
    expect(s.systemStatus).not.toBeNull();
    s.reset();
    expect(s.unit).toBeNull();
    expect(s.waterTempCentiC).toBeNull();
    expect(s.systemStatus).toBeNull(); // no stale software version for the next unit
    s.handle(channelSettings(0, 1));
    s.handle(segment({ seq: 1, seg: 0, count: 1, total: 1, offset: 0, data: [1], setting: 0 }));
    expect(cols).toHaveLength(0); // the old results must not be reused
  });

  test('uses the app default ping configurations before any data', () => {
    const s = new Sonar4Session();
    s.handle(channelSettings(0, 4));
    s.handle(channelSettings(1, 8));
    expect(s.indexFor(0)).toBe(0);
    expect(s.indexFor(1)).toBe(1);
    const out = s.buildChannelCommands(1, { gain: 70 });
    expect(parseChannelSettings(out[0])).toMatchObject({ index: 1, gain: 70, seq: 9 });
  });

  test('ignores a wrong protocol version and malformed messages', () => {
    const s = new Sonar4Session();
    const warns: string[] = [];
    s.on('warn', (w) => warns.push(w));
    const bad = msg(MsgId.BOTTOM, 22, (b) => b.writeUInt32LE(115, 8));
    expect(s.handle(bad)).toBeNull();
    expect(s.handle(msg(MsgId.ENV, 30))).toBeNull();
    expect(warns).toHaveLength(2);
  });

  test('is ready once the unit, every required message and all 32 ping configurations were seen', () => {
    const s = new Sonar4Session();
    const unit = unitMsg(67);
    s.handle(msg(MsgId.ENV, 68));
    s.handle(msg(MsgId.ERROR, 20));
    s.handle(msg(MsgId.SYS_STATUS, 1063));
    s.handle(systemSettings(1));
    for (let i = 0; i < 31; i++) s.handle(channelSettings(i, 1));
    s.handle(unit);
    expect(s.ready).toBe(false);
    s.handle(channelSettings(40, 1)); // rejected: index out of range
    expect(s.ready).toBe(false);
    s.handle(channelSettings(31, 1));
    expect(s.ready).toBe(true);
    s.reset();
    expect(s.ready).toBe(false);
  });

  test('only a newer settings seq replaces what is held', () => {
    const s = new Sonar4Session();
    s.handle(channelSettings(0, 5, { gain: 10 }));
    s.handle(channelSettings(0, 4, { gain: 90 }));
    expect(s.channelSettings(0)!.gain).toBe(10);
    s.handle(channelSettings(0, 6, { gain: 90 }));
    expect(s.channelSettings(0)!.gain).toBe(90);
  });

  test('channel commands: sensitivity for one channel, range for both, seq + 1', () => {
    const s = new Sonar4Session();
    s.handle(channelSettings(0, 5));
    s.handle(channelSettings(1, 9));
    s.handle(results(1, 0, 0, 1000)); s.handle(segment({ seq: 1, seg: 0, count: 1, total: 1, offset: 0, data: [1], setting: 0 }));
    s.handle(results(2, 1, 0, 1000)); s.handle(segment({ seq: 2, seg: 0, count: 1, total: 1, offset: 0, data: [1], setting: 1 }));

    const gain = s.buildChannelCommands(0, { gain: 80, gainAuto: false });
    expect(gain).toHaveLength(1);
    expect(parseChannelSettings(gain[0])).toMatchObject({ index: 0, seq: 6, gain: 80, gainAuto: false });

    const range = s.buildChannelCommands(1, { rangeAuto: false, rangeDeepCm: 3000, contrast: 20 });
    expect(range).toHaveLength(2);
    const [a, b] = range.map((r) => parseChannelSettings(r)!);
    expect(a).toMatchObject({ index: 0, seq: 7, rangeAuto: false, rangeDeepCm: 3000, contrast: 0 });
    expect(b).toMatchObject({ index: 1, seq: 10, rangeAuto: false, rangeDeepCm: 3000, contrast: 20 });
    expect(Buffer.from(range[1])[73]).toBe(0xab);
    // The second command was built on the first, unconfirmed one: it keeps gain 80.
    expect(a.gain).toBe(80);
    expect(s.channelSettings(0)!.gain).toBe(80);
    // A broadcast at our seq is the sonar's truth, here another client's change.
    s.handle(channelSettings(0, 7, { gain: 50 }));
    expect(s.channelSettings(0)!.gain).toBe(50);
  });

  describe('unconfirmed settings changes', () => {
    /** Session holding configuration 0 at seq 5, gain 10. */
    const held = () => {
      const s = new Sonar4Session();
      s.handle(channelSettings(0, 5, { gain: 10 }));
      return s;
    };

    test('are shown at once and confirmed by the sonar broadcasting them', () => {
      const s = held();
      s.buildChannelCommands(0, { gain: 80 }, 0);
      expect(s.channelSettings(0)!.gain).toBe(80);
      expect(s.pending).toBe(true);
      s.handle(channelSettings(0, 6, { gain: 80 }));
      expect(s.pending).toBe(false);
      expect(s.retryPending(5000)).toEqual([]);
    });

    test('are sent again while the sonar keeps reporting older settings, then given up', () => {
      const s = held();
      const seen: number[] = [];
      s.on('channelSettings', (c) => seen.push(c.gain));
      const warns: string[] = [];
      s.on('warn', (m) => warns.push(m));
      const [cmd] = s.buildChannelCommands(0, { gain: 80 }, 0);
      s.handle(channelSettings(0, 5, { gain: 10 })); // lost: the sonar still has seq 5
      expect(s.channelSettings(0)!.gain).toBe(80);
      expect(s.retryPending(100)).toEqual([cmd]); // stale: resend at once, same datagram
      s.handle(channelSettings(0, 5, { gain: 10 }));
      expect(s.retryPending(200)).toEqual([cmd]);
      s.handle(channelSettings(0, 5, { gain: 10 }));
      expect(s.retryPending(300)).toEqual([]); // third send unanswered: back to the sonar's values
      expect(s.channelSettings(0)!.gain).toBe(10);
      expect(s.pending).toBe(false);
      expect(seen).toEqual([80, 10]);
      expect(warns.join()).toMatch(/did not apply/);
    });

    test('resend after RESEND_MS without evidence, and stay shown when the sonar is silent', () => {
      const s = held();
      s.buildChannelCommands(0, { gain: 80 }, 0);
      expect(s.retryPending(RESEND_MS - 1)).toHaveLength(0);
      expect(s.retryPending(RESEND_MS)).toHaveLength(1);
      expect(s.retryPending(2 * RESEND_MS)).toHaveLength(1);
      expect(s.retryPending(10 * RESEND_MS)).toHaveLength(0); // MAX_SENDS reached
      expect(s.channelSettings(0)!.gain).toBe(80);
      // A late echo still confirms it.
      s.handle(channelSettings(0, 6, { gain: 80 }));
      expect(s.pending).toBe(false);
      expect(MAX_SENDS).toBe(3);
    });

    test('system settings follow the same rules', () => {
      const s = new Sonar4Session();
      s.handle(systemSettings(3, 0));
      s.buildSystemCommand({ transducerOffsetCm: 40 }, 0);
      expect(s.system!.transducerOffsetCm).toBe(40);
      for (let i = 1; i <= 3; i++) {
        s.handle(systemSettings(3, 0));
        s.retryPending(i * 10);
      }
      expect(s.system!.transducerOffsetCm).toBe(0);
      s.buildSystemCommand({ transducerOffsetCm: 40 }, 100);
      s.handle(systemSettings(4, 40));
      expect(s.pending).toBe(false);
      expect(s.system!.transducerOffsetCm).toBe(40);
    });

    test('a reconnect forgets them', () => {
      const s = held();
      s.buildChannelCommands(0, { gain: 80 }, 0);
      s.reset();
      expect(s.pending).toBe(false);
    });

    test('a stale change is rebuilt on another client\'s newer settings, keeping both changes', () => {
      const s = held(); // configuration 0 at seq 5, gain 10
      const shown: number[][] = [];
      s.on('channelSettings', (c) => shown.push([c.seq, c.gain, c.contrast, c.noiseFilter]));
      s.buildChannelCommands(0, { gain: 80 }, 0); // seq 6
      s.buildChannelCommands(0, { contrast: 20 }, 10); // seq 7, built on the unconfirmed seq 6
      // Another client's change landed first: the sonar now holds seq 6 with noise filter 33.
      const other = channelSettings(0, 6, { gain: 10 });
      other[CS.NOISE] = 33;
      s.handle(other);
      expect(s.pending).toBe(true);
      const [resend] = s.retryPending(20);
      const p = parseChannelSettings(resend)!;
      // Rebuilt on the sonar's seq 6 copy at seq 7: their noise filter survives, our gain and contrast are re-applied.
      expect(p).toMatchObject({ seq: 7, gain: 80, contrast: 20, noiseFilter: 33 });
      expect(s.channelSettings(0)).toMatchObject({ gain: 80, contrast: 20, noiseFilter: 33 });
      expect(shown.at(-1)).toEqual([7, 80, 20, 33]);
      // The sonar applies it and confirms.
      const confirm = channelSettings(0, 7, { gain: 80 });
      confirm[CS.CONTRAST] = 20; confirm[CS.NOISE] = 33;
      s.handle(confirm);
      expect(s.pending).toBe(false);
      expect(s.retryPending(5000)).toEqual([]);
    });

    test('a stale system change is rebuilt on the sonar\'s newer copy too', () => {
      const s = new Sonar4Session();
      s.handle(systemSettings(3, 0, 1));
      s.buildSystemCommand({ transducerOffsetCm: 40 }, 0); // seq 4
      s.buildSystemCommand({ simulator: true }, 1); // seq 5
      s.handle(systemSettings(4, 0, 2)); // another client switched the unit to fathoms
      const [resend] = s.retryPending(10);
      expect(parseSystemSettings(resend)).toMatchObject({ seq: 5, transducerOffsetCm: 40, simulator: true, depthUnit: 2 });
      expect(s.system).toMatchObject({ transducerOffsetCm: 40, simulator: true, depthUnit: 2 });
    });
  });

  test('clearReadings blanks depth and temperature without emitting', () => {
    const s = new Sonar4Session();
    let events = 0;
    s.on('bottom', () => events++);
    s.on('temperature', () => events++);
    s.handle(bottomMsg(1234));
    s.handle(envMsg(1530));
    expect(events).toBe(2);
    s.clearReadings();
    expect(s.bottomCm).toBeNull();
    expect(s.waterTempCentiC).toBeNull();
    expect(events).toBe(2);
  });

  test('reset lets warnings repeat for the next connection', () => {
    const s = new Sonar4Session();
    const warns: string[] = [];
    s.on('warn', (w) => warns.push(w));
    const bad = msg(MsgId.BOTTOM, 22, (b) => b.writeUInt32LE(115, 8));
    s.handle(bad); s.handle(bad);
    expect(warns).toHaveLength(1);
    s.reset();
    s.handle(bad);
    expect(warns).toHaveLength(2);
  });

  test('system command needs the device settings first', () => {
    const s = new Sonar4Session();
    expect(s.buildSystemCommand({ simulator: true })).toBeNull();
    s.handle(systemSettings(3, 0));
    const m = s.buildSystemCommand({ transducerOffsetCm: 45 })!;
    expect(parseSystemSettings(m)).toMatchObject({ seq: 4, transducerOffsetCm: 45 });
    expect(Buffer.from(m).readInt32LE(SS.TRANSDUCER_OFFSET)).toBe(45);
    expect(s.system!.transducerOffsetCm).toBe(45);
  });

  test('decodes unit, bottom and temperature events', () => {
    const s = new Sonar4Session();
    s.handle(unitMsg(67, 'DF4'));
    s.handle(bottomMsg(1234));
    s.handle(envMsg(1530));
    expect(s.unit).toMatchObject({ type: 67, name: 'DF4' });
    expect(s.bottomCm).toBe(1234);
    expect(s.waterTempCentiC).toBe(1530);
  });
});
