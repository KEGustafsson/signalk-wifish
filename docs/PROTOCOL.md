# Raymarine Wi-Fish / Dragonfly Pro — "Sonar4" network protocol

Derived from static analysis of the Android app `com.raymarine.wi_fish` v0.7.1
(decompiled with jadx). Offsets are byte offsets from the start of the UDP payload.
**All integers are little-endian.** Confidence: ✅ read directly from code,
🟡 inferred from usage, 📡 read off a capture from a real unit, ❓ unknown.

Fields marked 📡 come from captures of a **Wi-Fish dv (E70290), firmware 13.31**
(see §8). A Wi-Fish has one channel (DownVision, ping configuration 1) and no
GPS, so Dragonfly-only fields and the second channel are still ❓ there.

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
| 4 | u32 | device serial, same value as msg 1 off 8 📡 |
| 8 | u32 | service id: **39 = sonar data**, 15 = waypoint TCP ✅ |
| 12 | u32 | 0 📡 |
| 16 | u16, u16 | 0, then 45 📡 (service 39) |
| 20..23 | 4×u8 | service 39: data multicast group, dotted order `b20.b21.b22.b23` ✅ (service 15: IP in reverse byte order 🟡) |
| 24 | u32 | service port (39: data multicast port) ✅ |
| 28..31 | 4×u8 | device IP, dotted order ✅ |
| 32 | u32 | device control (unicast) port ✅ |
| 36 | u16 | length of the service-name string, including its NUL 📡 |
| 38.. | char[] | service name, NUL-terminated: `/raymarine/DSM350/Database` 📡 |

A Wi-Fish announces **only service 39**; no service 15 (waypoints) — it has no
GPS or waypoint store. The announcement repeats about once a second 📡.

### Unit identification — msg id `1`
| Off | Type | Meaning |
|---|---|---|
| 4 | u32 | unit type: 63 Wi-Fish dv, 66 Dragonfly-5 Pro, 67 Dragonfly-4 Pro, 78 Dragonfly-7 Pro ✅ |
| 8 | u32 | device serial, shown as hex ✅ (`c7c035c5` on the test unit, and the value in header off 12 of every device message 📡) |
| 12 | u32 | software version × 100: `1331` = 13.31, matching system status off 18/19 📡 |
| 16..19 | 4×u8 | device IP in **reverse** byte order (`01 00 a8 c0` = 192.168.0.1) 📡 |
| 20..51 | char[32] | unit name, NUL-padded ✅ (`E70290`, the Wi-Fish part number) |

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
| 12 | u32 | session value: the **device serial** in every device → client message 📡 (the app sends 0xDEADBEEF here in its keepalive and the device accepts it; no other value was tried) |
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
| 0x270105 | 2556165 | Range preset / limit table, ignored by app | 35 📡 |
| 0x270106 | 2556166 | System settings (also sent by client) | 562 |
| 0x270107 | 2556167 | Settings limits, ignored by app | 49 📡 |
| 0x270108 | 2556168 | Master bottom record (**depth**) | 22 |
| 0x270109 / 0x27010A | | Transducer channel descriptor, ignored by app | 1383 / 57 📡 |
| 0x27010B | 2556171 | Ping results (per-ping metadata) | 130 |
| 0x27010D | 2556173 | Error status | 20 |
| 0x27010E | 2556174 | Recording / log status text, ignored by app | 85 📡 |

A message shorter than its minimum length, or shorter than its own header
length field (off 4), is malformed and should be dropped.

Observed rates on a Wi-Fish 📡: ping data, ping results and bottom records
~28 /s each; channel settings ~26 /s (all 32 configurations about 0.8 /s each);
environment, error, system status, system settings, 0x270105, 0x270107,
0x270109, 0x27010A ~0.8 /s each; 0x27010E ~0.1 /s; discovery msg 0 and msg 1
~0.8 /s each. The ids the app ignores are sent whether or not a client asks
for them, so a client must skip unknown 0x2701xx ids silently.

### Master bottom record — 0x270108 ✅
| Off | Type | Meaning |
|---|---|---|
| 16 | u8 | clamped 0..3 by app ❓ (bottom-lock quality?); constant **2** with lock on a Wi-Fish 📡 |
| 17 | i32 | **depth, cm**; `INT32_MIN` = no bottom lock ✅ |
| 21 | u8 | clamped 0..2 by app; the **channel** the depth came from, same codes as ping results off 95 📡 (1 = DownVision on a Wi-Fish, its only channel) |

The app shows this value as the depth readout (negative values as 0) and hands `depth − offset`
to the traces, where offset is the transducer offset from system settings
(off 60, §6) ✅. The traces are transducer-relative, so the reported depth
already has the offset applied ✅ (confirmed on hardware):
offset > 0 → depth below surface, offset < 0 → depth below keel, 0 → below
transducer. The app updates the readout at most once per second and blanks
it when no valid depth has come for 6 s after a no-lock record.

### Environment data — 0x270104, 68 bytes

A block of i16 sensor values, each invalid as `INT16_MIN`, closed by an i32.
Only the water temperature is used by the app.

| Off | Type | Meaning |
|---|---|---|
| 16 | u8, u8 | 0, 1 📡 |
| 18 | i16 | −1 📡 |
| 20..27 | 4×i16 | 0 📡 |
| 28 | i16 | **water temperature, centi-°C**; `INT16_MIN` = invalid ✅ |
| 30, 32, 34, 36, 38 | 5×i16 | further sensor slots, all `INT16_MIN` (invalid) on a Wi-Fish 📡 (candidates: speed, heading — a Wi-Fish has neither) |
| 40 | i16 | **supply voltage, mV** 📡 |
| 42 | i16 | **lowest supply voltage seen, mV** 🟡 — constant 12598 across both captures, below every instantaneous reading; a low-water mark by symmetry with off 44 |
| 44 | i16 | **highest supply voltage seen, mV** 📡 — steps up exactly when off 40 exceeds it and never down |
| 46, 48, 50 | 3×i16 | −1 📡 |
| 52 | i16 | 200 📡 |
| 54, 56 | 2×i16 | `INT16_MIN` (invalid) 📡 |
| 58, 60, 62 | 3×i16 | −1 📡 |
| 64 | i32 | 193 📡 |

The voltage reading was cross-checked against the boat's battery monitor:
off 40 tracked 13.18–13.29 V while the house battery (on charge) measured
13.57 V, the difference being the drop along the sonar's supply run. It is most
likely the reading behind the low-voltage error flag (0x27010D).

### Error status — 0x27010D
| Off | Type | Meaning |
|---|---|---|
| 16 | u32 | error flags; bit **0x100 = supply voltage too low** (the app opens its low-voltage dialog while set, closes it when clear) ✅; 0 throughout the captures 📡 |

### System status — 0x270103
| Off | Type | Meaning |
|---|---|---|
| 16 | i16 | −1 📡 |
| 18 | u8 | software major version ✅ (the app warns Dragonfly-4/5 owners below a minimum); 13 📡 |
| 19 | u8 | software minor version ✅; 31 📡 — msg 1 off 12 carries the same version as 1331 |
| 20 | u16 | 6 📡 |
| 22 | i16 | −1 📡 |
| 24 | i16 | varies 49..56, noisy, not monotonic 📡 ❓ (candidates: CPU load %, internal temperature °C) |
| 26 | i16 | 18 📡 |
| 28 | i16 | 15 📡 |
| 30 | u8 | 1 📡 |
| 31 | u32 | 2047 📡 |
| 35 | u8 | 0 📡 |
| 36 | i16 | varies 288..296, noisy 📡 ❓ (an internal temperature in deci-°C would fit; its high byte, off 37, stayed 1) |
| 38 | u8 | 0 📡 |
| 39..1099 | char[] | status text, NUL-terminated and trimmed 🟡; ends at off 1099 or at the end of the message, whichever comes first, so a message of the 1063-byte minimum carries 1024 bytes of it; all zero (empty) on a Wi-Fish 📡 |

### Ping data — 0x270101 ✅ (segmented; reassemble per ping)
| Off | Type | Meaning |
|---|---|---|
| 16 | u32 | error code, must be 0 |
| 20 | u32 | byte offset of this segment in the column |
| 24 | u32 | total column length (≤ 1024) |
| 28 | u32 | equal to off 24 in every captured column 📡 ❓ (only single-segment columns were seen, so "segment length" and "sample count" both still fit) |
| 32 | u8 | data type; 4 on a Wi-Fish 📡 |
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
| 17 | i32 | settings seq of the channel settings this ping was made with 📡 (the value in 0x270102 off 16 of that configuration) |
| 21 | i32 | **ping configuration index**, same as ping data off 36 📡 |
| 25..53 | | 0 📡 |
| 54..94 | | a **copy of this configuration's channel settings**, offsets 53..93 of 0x270102 shifted by +1 📡 (so e.g. auto-resolved gain is at off 80, contrast at 78, noise filter at 82) |
| 95 | u8 | **channel: 0 = CHIRP sonar, 1 = DownVision** ✅ — the first byte after that copy |
| 96 | u16 | 0 📡 |
| 98 | u8, u8 | 93, 100 📡 |
| 100 | u32 | varies slowly in a narrow band (34873683..34874702 over 150 s, not monotonic) 📡 ❓ |
| 104 | i32 | 🟡 range start (cm) — 0 📡 |
| 108 | i32 | 🟡 range end (cm) — 400 📡, matching the Range ▸ Auto window |
| 112 | i32 | 632 📡, the same value as in the transducer descriptor (§5.1), so a transducer property rather than a per-ping one |
| 116..125 | | 0 📡 |
| 126, 128 | 2×i16 | 32, 37 📡 |

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

### 5.1 Messages the app ignores 📡

The device sends these whether or not anything listens. They carry no reading a
client needs, but they do confirm limits the app hard-codes, which is why they
are written down here. All values below are from a Wi-Fish, firmware 13.31.

**Transducer channel descriptor — 0x27010A (57 bytes) and 0x270109 (1383
bytes)**: the same payload, the long one zero-padded (room for several
channels, one filled on a Wi-Fish).

| Off | Type | Value |
|---|---|---|
| 16 | u8 | 1 (channel count, or the channel's index) |
| 17..41 | char[25] | channel name, NUL-padded: `DF_200k_35` |
| 42 | u8 | 1 |
| 43 | u16 | 2000 = **200.0 kHz**, the DownVision frequency |
| 45 | u16 | 3500 = **35.00°**, the DownVision beam width |
| 47, 48 | u8, u8 | 50, 50 |
| 49 | u16 | 632 (also ping results off 112) |
| 51, 53 | 2×u16 | 200, 200 |
| 55, 56 | u8, u8 | 0, 0 |

**Settings limits — 0x270107 (49 bytes)**: `1, 800, 1, 500,` then
i32 **−300** and i32 **+300** — the transducer-offset range the app enforces
(§6) — then i16 −550 and +550, a byte 1, a f32 ≈ 0.01714, i32 100 and
i32 40000 (a 1 m … 400 m range limit in cm would fit).

**Range preset / limit table — 0x270105 (35 bytes)**: u16 650, 700, 750, 800,
then 10500, 10000, 30000, 34000, 500 and a byte 5. Constant.

**Recording status — 0x27010E (85 bytes)**: u8 8, u32 0x00076c42, then the text
`Firefly_FifoData_0_0.rec 0kB \nNormal` — the unit's internal recorder, idle.
Sent about once every 10 s.

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
| 16 | i32 | settings seq, counted **per configuration** 📡 (0 on configurations never written; 42 and 299 on the two the unit uses) | |
| 20 | u8 | ping configuration index (< 32) | |
| 21..52 | char[32] | name | |
| 53, 54 | u8, u8 | 0/1 flags 📡 (54 was 1 on 7 of the 32 configurations, 53 on 2) | |
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
| 56..61 | u8 | 0, 50, 0, 1, 1, 100 📡 | |
| 71..75 | u8 | 0, 0, 0, 1, 10 📡 | |
| 82..93 | u8 | 1, 1, 1, 2, 50, 50, 1, 0, 1, 0, 0, 0 📡 (identical on all 32 configurations) | |

On a Wi-Fish 📡 exactly one configuration is enabled (index **1**, DownVision);
all 32 are broadcast all the same, and a client must draw only the enabled ones.
The 30 configurations the unit never writes carry **uninitialised memory** in
the name field — a leftover C++ string, `Error in COSSLinuxFile::Chec…`, starting
at off 25 rather than at off 21, so a NUL-terminated read at off 21 yields the
empty string the app expects. Treat the name as untrusted: not necessarily
NUL-terminated, printable, or even stable between messages. Their other fields
hold defaults (range auto, 0‥1000 cm, contrast 80, gain 40, noise filter 30).

Range presets offered by the app (Shallow lists presets below Deep, Deep
presets above Shallow), sent as `trunc(preset × unit)` cm:
- feet (30.48): 5 6 8 10 12 15 18 20 24 30 35 40 50 60 80 100 120 150 180 240 300 350 400 500 600 800 1000 1200
- metres (100): 2 3 4 5 6 8 10 12 15 18 20 24 30 35 40 50 60 80 100 120 150 180 240 300 360
- fathoms (182.88): 1 2 3 4 5 6 8 10 12 15 18 20 24 30 35 40 50 60 80 100 125 150 180 200

### System settings — 0x270106, 562 bytes
| Off | Type | Meaning |
|---|---|---|
| 16 | i32 | settings seq (56 📡) |
| 20..52 | char[33] | name (`WiFishdv` 📡) |
| 53 | u8 | 254 📡 |
| 54 | i16 | 300 📡 — the ±300 cm transducer-offset limit the app enforces, which 0x270107 (§5.1) also announces |
| 56..59 | u8 | 1, 1, 100, 0 📡 |
| 60 | i32 | **transducer offset, cm**, ±300: > 0 transducer below waterline, < 0 above keel (−30 on the test unit 📡, i.e. 30 cm above the keel) |
| 64 | i16 | 0 📡 |
| 66, 67 | u8, u8 | 50, 50 📡 |
| 68 | i16 | 14930 📡 (bytes `52 3a`) |
| 70 | u8 | 4 📡 |
| 71 | i32 | 3 📡 |
| 75 | i32 | 0 📡 |
| 79 | u8 | depth unit: 0 feet, 1 metres, 2 fathoms (the app adopts it for display) |
| 80 | u8 | **simulator**: 2 = on, 0 = off (the app shows a blinking "Simulated data") |
| 81 / 241 / 401 | i32[40] ×3 | range preset tables in cm for feet / metres / fathoms, −1 padded (the app rewrites them from its constants) |
| 561 | u8 | 3 📡 |

The preset tables the unit broadcasts 📡 match the app's constants above, each
preceded by a 0 entry: feet `0 152 182 243 304 365 457 548 609 731 914 …`
(5 ft = trunc(5 × 30.48) = 152), metres `0 200 300 400 500 600 800 1000 …`,
fathoms `0 182 365 548 731 914 1097 …`, the rest of each table −1.

## 7. Hardware validation

Confirmed on a real unit: multicast discovery and keepalive session, CHIRP sonar and
DownVision ping data and results, depth and water temperature, settings
read-modify-write (gain, contrast, noise filter, range, transducer offset, simulator)
and the transducer offset convention in §5.

**A second client is accepted** 📡: with a Signal K server holding a session
(keepalive once a second, "connected"), a second client on the same Wi-Fi joined
the data group and received every message at the same rate, both passively and
while sending its own keepalives. Neither client's stream was interrupted. Sonar
data is multicast and both settings messages are broadcast, so a settings change
by one client reaches the others as soon as the unit rebroadcasts it — which is
also what the read-modify-write scheme in §6 relies on.

Still open:
- Does data flow without a keepalive at all? How long after the last keepalive
  does it stop? (Untested: the sessions above always had one client keeping the
  unit alive.)
- Does a settings command from a second *controlling* client take effect, and
  does the first client's held copy follow? (Only the keepalive path was tested
  from two clients; no settings were written from the second one.)
- The ❓ fields left in §5: ping results off 100, system status off 24 and 36,
  ping data off 28 (needs a multi-segment column, i.e. a Dragonfly).
- Everything Dragonfly-only: the CHIRP sonar channel, a second enabled ping
  configuration, service 15 (waypoints over TCP), and whether unused ping
  configurations carry real names there.

## 8. Captures behind the 📡 fields

Taken on 2026-10-02 from a Wi-Fish dv, part number E70290, serial `c7c035c5`,
firmware 13.31, in 2.1 m of water with Range ▸ Auto (window 0…400 cm, 441
samples per column), transducer offset −30 cm, depth unit metres, simulator off,
supply ≈ 13.3 V:

```sh
node tools/wifish-probe.mjs --iface <wlan IP> --no-keepalive --log raw.bin   # 150 s, 18 195 datagrams
node tools/dump-raw.mjs raw.bin --id 0x270104 --hex                          # one message type
```

Field meanings were read off the capture by listing, per message id and per byte
offset, which offsets are constant and which vary, then correlating the varying
ones with values known from elsewhere: the water temperature and depth the unit
reports, the boat's own battery monitor (for §5's supply voltage), and the
firmware version in two different messages.
