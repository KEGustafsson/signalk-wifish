# Raymarine Wi-Fish / Dragonfly Pro — "Sonar4" network protocol

Derived from static analysis of the Android app `com.raymarine.wi_fish` v0.7.1
(decompiled with jadx). Offsets are byte offsets from the start of the UDP payload.
**All integers are little-endian.** Confidence: ✅ read directly from code,
🟡 inferred from usage, ❓ unknown / needs capture to confirm.

Supported units (unit-type codes): Wi-Fish dv = 63, Dragonfly-4 Pro = 67,
Dragonfly-5 Pro = 66, Dragonfly-7 Pro = 78. Protocol version constant = **116**.

## 1. Transport

| Channel | Addressing | Direction |
|---|---|---|
| Discovery | multicast `224.0.0.1:5800` | device → clients |
| Sonar data | multicast group + port **announced in discovery** | device → clients |
| Control / keepalive | unicast to device IP + control port **announced in discovery**, from an ephemeral local port | client → device |
| Waypoint sync | TCP, address announced in discovery (service 15) | bidirectional (ignore for sonar) |

The app binds to the local interface whose IPv4 starts with `192.` and holds a
Wi-Fi multicast lock. Receive buffer 2048 bytes.

## 2. Discovery (on 224.0.0.1:5800)

### Service announcement — msg id `0`
| Off | Type | Meaning |
|---|---|---|
| 0 | u32 | message id = 0 ✅ |
| 8 | u32 | service id: **39 = sonar data**, 15 = waypoint TCP ✅ |
| 20..23 | 4×u8 | service 39: data multicast group, dotted order `b20.b21.b22.b23` ✅ (service 15: IP in reverse byte order 🟡) |
| 24 | u32 | service port (39: data multicast port) ✅ |
| 28..31 | 4×u8 | device IP, dotted order ✅ |
| 32 | u32 | device control (unicast) port ✅ |

### Unit identification — msg id `1`
| Off | Type | Meaning |
|---|---|---|
| 4 | u32 | unit type: 63 Wi-Fish dv, 66 Dragonfly-5 Pro, 67 Dragonfly-4 Pro, 78 Dragonfly-7 Pro ✅ |
| 8 | u32 | shown as hex, probably serial 🟡 |
| 12 | u32 | ❓ |
| 20..51 | char[32] | unit name, NUL-padded ✅ |

## 3. Session sequence ✅

1. Join `224.0.0.1:5800`; wait for **msg 0 / service 39** and **msg 1**.
2. Join the announced data group:port.
3. Every **1 s**, send a keepalive (§4) to device IP : control port.
4. Wait until the unit id (msg 1), env data (0x270104), error status
   (0x27010D), system status (0x270103), system settings (0x270106) and the
   channel settings (0x270102) of **all 32 ping configurations** have each
   arrived at least once (`d0.c.c()` sums the decoders' outstanding counts; the
   channel-settings decoder counts every index 0‥31 not yet seen). Then set
   keepalive byte 16 = 1 ("connected"). The app gives up after 15 s.
5. Stream ping data / results / bottom depth.

## 4. Sonar4 common header (all 0x2701xx messages)

| Off | Type | Meaning |
|---|---|---|
| 0 | u32 | message id ✅ |
| 4 | u32 | total message length ✅ |
| 8 | u32 | protocol version, must be 116 ✅ |
| 12 | u32 | sequence / session value ✅ |
| 16.. | | payload |

### Keepalive — `0x270100` (2556160), client → device, 37 bytes ✅
| Off | Value |
|---|---|
| 0 | 0x270100 |
| 4 | 37 |
| 8 | 116 |
| 12 | 0xDEADBEEF |
| 16 | u8 state: 0 = connecting, 1 = all required messages received |
| 17 | u64 unix time (seconds) |
| 25 | i64 −1 |
| 33 | i32 INT32_MIN (−2³¹, bytes `00 00 00 80`) |

## 5. Device → client messages

| Id | Dec | Name | Min len |
|---|---|---|---|
| 0x270101 | 2556161 | Ping data (sample segments) | 37 |
| 0x270102 | 2556162 | Sonar channel settings (also sent by client) | 94 |
| 0x270103 | 2556163 | System status | 1063 |
| 0x270104 | 2556164 | Environment data | 68 |
| 0x270106 | 2556166 | System settings (also sent by client) | 562 |
| 0x270108 | 2556168 | Master bottom record (**depth**) | 22 |
| 0x270109 / 0x27010A | | ignored by app | |
| 0x27010B | 2556171 | Ping results (per-ping metadata) | 130 |
| 0x27010D | 2556173 | Error status | 20 |

A message shorter than its minimum length, or shorter than its own header
length field (off 4), is malformed and should be dropped.

### Master bottom record — 0x270108 ✅
| Off | Type | Meaning |
|---|---|---|
| 16 | u8 | clamped 0..3 by app ❓ (bottom-lock quality?) |
| 17 | i32 | **depth, cm**; `INT32_MIN` = no bottom lock ✅ |
| 21 | u8 | clamped 0..2 ❓ (channel/source?) |

The app shows this value as the depth readout (negative values as 0) and hands `depth − offset`
to the traces, where offset is the transducer offset from system settings
(off 60, §6) ✅. The traces are transducer-relative, so the reported depth
already has the offset applied ✅ (confirmed on hardware):
offset > 0 → depth below surface, offset < 0 → depth below keel, 0 → below
transducer. The app updates the readout at most once per second and blanks
it when no valid depth has come for 6 s after a no-lock record.

### Environment data — 0x270104
| Off | Type | Meaning |
|---|---|---|
| 28 | i16 | **water temperature, centi-°C**; `INT16_MIN` = invalid ✅ |
| 16..27, 30..67 | | ~22 further fields, unused in UI ❓ (candidates: supply voltage, speed) |

### Error status — 0x27010D
| Off | Type | Meaning |
|---|---|---|
| 16 | u32 | error flags; bit **0x100 = supply voltage too low** (the app opens its low-voltage dialog while set, closes it when clear) ✅ |

### System status — 0x270103
| Off | Type | Meaning |
|---|---|---|
| 18 | u8 | software major version ✅ (the app warns Dragonfly-4/5 owners below a minimum) |
| 19 | u8 | software minor version ✅ |
| 16..38 | | further i16/u8/i32 fields, unused ❓ |
| 39..1099 | char[] | status text, trimmed 🟡 |

### Ping data — 0x270101 ✅ (segmented; reassemble per ping)
| Off | Type | Meaning |
|---|---|---|
| 16 | u32 | error code, must be 0 |
| 20 | u32 | byte offset of this segment in the column |
| 24 | u32 | total column length (≤ 1024) |
| 28 | u32 | ❓ |
| 32 | u8 | data type |
| 33 | u8 | ping sequence (matches Ping results off 16) |
| 34 | u8 | segment index |
| 35 | u8 | segment count |
| 36 | u8 | range/setting index 🟡 |
| 37.. | u8[] | echo samples (1 byte each, 🟡 0 = no return) |

Column complete when `segment == count − 1`. Drop the ping on a gap. The
column's length is the number of bytes received (`e0.e.f()`); `total` (off 24)
is only cross-checked and logged.

### Ping results — 0x27010B
| Off | Type | Meaning |
|---|---|---|
| 16 | u8 | ping sequence ✅ |
| 21 | u8 | ❓ |
| 95 | u8 | **channel: 0 = CHIRP sonar, 1 = DownVision** ✅ |
| 104 | i32 | 🟡 range start (cm) |
| 108 | i32 | 🟡 range end (cm) |
| 112..129 | | ❓ |

Pair each completed Ping data column with the Ping results of the same
sequence to get channel and vertical scale. The app re-checks the pairing on
**both** message types (`SounderService` task, 0x270101 and 0x27010B), so it
works whichever of the two arrives last.

**Vertical scale** ✅ (from the app's GL renderer): the *n* samples of a column
cover **0 … range end** below the transducer, sample *i* at
`(i + 0.5) / n × end`. The default view window is **range start … range end**.
Range start/end come from Ping results (off 104/108) when the channel's range
is auto, otherwise from its channel settings (off 63/67). Ping data off 36 is
the **ping configuration index** of the channel settings the column was made
with; the app draws only configurations whose settings it has received and
whose "enabled" byte (off 55, read signed) is > 0.
Samples are palette indices 0‥255. The app snaps the displayed window to the
nearest range preset of the current depth unit (`z.b.h()`), and when the unit
changes it snaps the channels' shallow/deep to the new unit's presets and sends
them (`SonarTraceActivity`).

## 6. Settings (client → device) ✅
Both settings messages are **read-modify-write**: the device broadcasts its
current state, the client sends a modified copy (same id, same layout, header
off 4/8/12 copied) to the device control port, with the settings seq at off 16
set to the last seq + 1. A received message replaces the held copy only if its
seq is newer. A passive depth reader never needs to send them. (This project
patches a copy of the received datagram so unknown bytes survive; the app
re-encodes from fields and, due to a bug, writes byte 72 back to off 73.)

The commands go over UDP and are not acknowledged; the device's next broadcast
is the only confirmation. This project therefore keeps the device's copy and
its own unconfirmed change apart: the change is shown at once and becomes the
held copy when the device broadcasts a seq at least as new. While the device
keeps broadcasting the older seq, the command is resent (up to 3 sends, 1 s
apart); after that its own values are shown again. Without any broadcast there
is no evidence either way and the change stays shown. Depth conversions always
use the device's confirmed transducer offset, since the device applies it.

### Sonar channel ("ping parameters") — 0x270102, exactly 94 bytes
One message per ping configuration (index 0‥31); the Sensitivity settings go to
the configuration of the channel being adjusted, Range settings to both channels'.

| Off | Type | Meaning | UI |
|---|---|---|---|
| 16 | i32 | settings seq | |
| 20 | u8 | ping configuration index (< 32) | |
| 21..52 | char[32] | name | |
| 55 | u8 | > 0 = configuration enabled | |
| 62 | u8 | range auto (1/0) | Range ▸ Auto |
| 63 | i32 | range shallow, cm | Range ▸ Shallow |
| 67 | i32 | range deep, cm | Range ▸ Deep |
| 71 | i16 | ❓ (the app decodes byte 72 on its own and writes it back to 73) | |
| 76 | u8 | contrast auto (1/0) | Sensitivity ▸ Contrast Auto |
| 77 | u8 | contrast 0‥100 | Sensitivity ▸ Contrast |
| 78 | u8 | gain auto (1/0) | Sensitivity ▸ Gain Auto |
| 79 | u8 | gain 0‥100 | Sensitivity ▸ Gain |
| 80 | u8 | noise filter auto (app writes 2 = auto, 0 = manual; reads > 0) | Sensitivity ▸ Noise filter Auto |
| 81 | u8 | noise filter 0‥100 | Sensitivity ▸ Noise filter |
| 53..61, 73..75, 82..93 | u8 | ❓ | |

Range presets offered by the app (Shallow lists presets below Deep, Deep
presets above Shallow), sent as `trunc(preset × unit)` cm:
- feet (30.48): 5 6 8 10 12 15 18 20 24 30 35 40 50 60 80 100 120 150 180 240 300 350 400 500 600 800 1000 1200
- metres (100): 2 3 4 5 6 8 10 12 15 18 20 24 30 35 40 50 60 80 100 120 150 180 240 300 360
- fathoms (182.88): 1 2 3 4 5 6 8 10 12 15 18 20 24 30 35 40 50 60 80 100 125 150 180 200

### System settings — 0x270106, 562 bytes
| Off | Type | Meaning |
|---|---|---|
| 16 | i32 | settings seq |
| 20..52 | char[33] | name |
| 52..59 | u8/i16 | ❓ |
| 60 | i32 | **transducer offset, cm**, ±300: > 0 transducer below waterline, < 0 above keel |
| 64 / 66 / 67 / 68 / 70 | i16 / u8 / u8 / i16 / u8 | decoded by the app, unused ❓ |
| 71 / 75 | i32 / i32 | decoded by the app, unused ❓ |
| 79 | u8 | depth unit: 0 feet, 1 metres, 2 fathoms (the app adopts it for display) |
| 80 | u8 | **simulator**: 2 = on, 0 = off (the app shows a blinking "Simulated data") |
| 81 / 241 / 401 | i32[40] ×3 | range preset tables in cm for feet / metres / fathoms, −1 padded (the app rewrites them from its constants) |
| 561 | u8 | ❓ |

## 7. Hardware validation

Confirmed on a real unit: multicast discovery and keepalive session, CHIRP sonar and
DownVision ping data and results, depth and water temperature, settings
read-modify-write (gain, contrast, noise filter, range, transducer offset, simulator)
and the transducer offset convention in §5.

Still open:
- Does the unit accept a second client (Jetson + phone at once)? Do settings from one client show up in the other?
- Does data flow without a keepalive? How long after the last keepalive does it stop?
- Semantics of the ❓ fields, especially Environment data and Ping results.
