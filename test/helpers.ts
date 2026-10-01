import { VERSION, MsgId, CHAN_SETTINGS_LEN, SYS_SETTINGS_LEN, CS, SS } from '../src/sonar4';

/** A Sonar4 message: 16-byte header + caller-filled payload. */
export function msg(id: number, len: number, fill: (b: Buffer) => void = () => {}): Buffer {
  const b = Buffer.alloc(len);
  b.writeUInt32LE(id, 0); b.writeUInt32LE(len, 4); b.writeUInt32LE(VERSION, 8); b.writeUInt32LE(7, 12);
  fill(b);
  return b;
}

export function segment({ seq, seg, count, total, offset, data, error = 0, setting = 5 }:
  { seq: number; seg: number; count: number; total: number; offset: number; data: number[]; error?: number; setting?: number }): Buffer {
  return msg(MsgId.PING_DATA, 37 + data.length, (b) => {
    b.writeUInt32LE(error, 16); b.writeUInt32LE(offset, 20); b.writeUInt32LE(total, 24);
    b[32] = 2; b[33] = seq; b[34] = seg; b[35] = count; b[36] = setting;
    Buffer.from(data).copy(b, 37);
  });
}

export function results(seq: number, channel: number, startCm: number, endCm: number): Buffer {
  return msg(MsgId.PING_RESULTS, 130, (b) => { b[16] = seq; b[95] = channel; b.writeInt32LE(startCm, 104); b.writeInt32LE(endCm, 108); });
}

export function channelSettings(index: number, seq: number, o: Partial<{ enabled: number; rangeAuto: number; shallow: number; deep: number; gain: number; gainAuto: number }> = {}): Buffer {
  return msg(MsgId.CHAN_SETTINGS, CHAN_SETTINGS_LEN, (b) => {
    b.writeInt32LE(seq, CS.SEQ);
    b[CS.INDEX] = index;
    b.write('CHIRP', CS.NAME, 'latin1');
    b[CS.ENABLED] = o.enabled ?? 1;
    b[CS.RANGE_AUTO] = o.rangeAuto ?? 1;
    b.writeInt32LE(o.shallow ?? 0, CS.RANGE_SHALLOW);
    b.writeInt32LE(o.deep ?? 2000, CS.RANGE_DEEP);
    b[CS.GAIN_AUTO] = o.gainAuto ?? 1;
    b[CS.GAIN] = o.gain ?? 50;
    b[73] = 0xab; // unknown byte that must survive read-modify-write
  });
}

export function systemSettings(seq: number, offsetCm = 0, unit = 1): Buffer {
  return msg(MsgId.SYS_SETTINGS, SYS_SETTINGS_LEN, (b) => {
    b.writeInt32LE(seq, SS.SEQ);
    b.write('Demo', SS.NAME, 'latin1');
    b.writeInt32LE(offsetCm, SS.TRANSDUCER_OFFSET);
    b[SS.DEPTH_UNIT] = unit;
    b[200] = 0x5a; // unknown byte that must survive read-modify-write
  });
}
