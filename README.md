# signalk-wifish

Signal K plugin and web app for the Raymarine **Wi-Fish** and **Dragonfly-4/5/7 Pro**
Wi-Fi sonars. It does what the Android "Wi-Fish" app does, in a browser on any
device connected to your Signal K server:

- live **CHIRP sonar** and **DownVision** echograms, side by side or one at a time
- depth and water temperature readout, and both published to **Signal K**
- sonar adjustments sent to the unit: gain, contrast and noise filter (each with Auto),
  range (auto or shallow/deep), transducer depth and the unit's simulator
- pause and scroll back through history, pinch or mouse-wheel zoom with a zoom box,
  A-scope, depth lines, nine colour palettes, snapshots

![Sonar and DownVision](docs/screenshot.jpg)

**Status:** working on real hardware. The protocol was derived from static analysis of the
Android app and then validated against a unit: Wi-Fi discovery and session keepalive, CHIRP
sonar and DownVision echograms, depth and water temperature, settings changes and the
transducer offset all behave as the Android app does. A built-in demo sonar lets you try
everything without a unit.

## How it works

The sonar is a Wi-Fi access point. The machine running Signal K joins that network
(ideally on a second Wi-Fi interface, so Ethernet or another Wi-Fi stays the default
route, see [network setup](docs/network-setup.md)). The plugin listens for the sonar's
multicast announcement, keeps the session alive, decodes the "Sonar4" UDP protocol
([docs/PROTOCOL.md](docs/PROTOCOL.md)) and:

- publishes `environment.depth.belowTransducer` and `environment.water.temperature`
  (plus `environment.depth.belowSurface` or `belowKeel` when a transducer offset is set
  on the unit, with `surfaceToTransducer` / `transducerToKeel`). The unit holds one
  offset only; with it set to the keel, *Waterline to transducer* in the web app's
  settings adds `belowSurface` as well,
- streams echogram columns to the **Wi-Fish Sonar** web app, keeping recent history on the
  server so a browser opened later can scroll back,
- relays settings changes from the web app to the unit.

## Install

From the Signal K App Store search for **signalk-wifish**, or:

```sh
cd ~/.signalk
npm install signalk-wifish
```

Restart the server, enable **Wi-Fish / Dragonfly sonar** under *Server → Plugin Config*,
then open **Wi-Fish Sonar** from the *Webapps* page (`http://<server>:3000/signalk-wifish/`).

### Plugin options

| Option | Default | |
|---|---|---|
| Data source | `device` | `device` = the sonar on the joined Wi-Fi, `demo` = built-in simulated sonar, `replay` = a raw capture file |
| Wi-Fi interface address | empty | local IPv4 on the sonar Wi-Fi; empty picks the `192.x` address on the sonar's subnet, like the app |
| Control the sonar | on | send keepalives and settings; off = passive listener |
| Replay file | empty | absolute path of a capture made with `tools/wifish-probe.mjs --log` |
| Demo model | `dragonfly` | `dragonfly` (sonar + DownVision) or `wifish` (DownVision only) |
| History columns per channel | 1500 | echogram history kept on the server |
| Publish depth / water temperature | on | Signal K output |

Depth is sent on change (at most 5 Hz, 5 s heartbeat) and as `null` when the bottom is
lost or data stops, so displays don't show a stale depth; temperature at most once per
second with a 10 s heartbeat.

## Using the web app

The screen follows the Android app:

| | |
|---|---|
| Toolbar | view switcher, pause/resume, snapshot, and ⋯ for Settings, Help and About. On a Wi-Fish (DownVision only) the first button opens the sonar settings instead. |
| Tap a trace | shows its ⚙ button for 5 s; it opens the **Sensitivity / Range / Options** popover for that channel |
| Drag sideways | scroll back through history (pauses); ⏩ or dragging to the end returns to live |
| Pinch vertically / mouse wheel | zoom into the water column; the zoom box on the right shows the full range and follows the bottom. Double-tap to zoom out. |
| Pinch horizontally / Ctrl + wheel | scroll speed |
| Press and hold | depth, bottom, water temperature and time at that point |
| ⋯ → Settings | transducer depth, waterline to transducer, depth and temperature units, simulator |

![Sonar settings](docs/screenshot-settings.jpg)

Depth and temperature units and the waterline-to-transducer distance are kept by the plugin
(in its data directory), so they are the same on every browser and device and survive restarts. Palettes, view and similar
preferences are stored per browser.

## Development

Node.js 20+ to run the plugin; development tools (vite/vitest) need Node 20.19+ or 22.12+.

```sh
npm install          # also builds
npm test             # vitest
npm run dev          # web app with the demo sonar on http://localhost:3000/ (listens on 127.0.0.1; add --host 0.0.0.0 to share it)
node dist/devserver.js --demo --wifish            # Wi-Fish (DownVision only)
node dist/devserver.js --device [--iface 192.168.x.y] [--passive] [--deltas]
node dist/devserver.js --replay capture.bin
npm run watch:web    # rebuild the web app on change
```

| Path | What |
|---|---|
| [`src/sonar4.ts`](src/sonar4.ts) | pure protocol codec: parsers, keepalive, settings read-modify-write, ping reassembly |
| [`src/session.ts`](src/session.ts) | protocol state from any transport; builds settings commands |
| [`src/device.ts`](src/device.ts) | UDP transport: discovery, keepalive, reconnect |
| [`src/demo.ts`](src/demo.ts), [`src/replay.ts`](src/replay.ts) | demo sonar and capture replay transports |
| [`src/engine.ts`](src/engine.ts) | Signal K deltas, state and echogram history |
| [`src/api.ts`](src/api.ts), [`src/plugin.ts`](src/plugin.ts) | HTTP/SSE API and the plugin |
| [`web/`](web) | the web app (TypeScript, canvas, no framework), bundled to `public/` |
| [`tools/`](tools) | `wifish-probe.mjs` (hardware test client, raw logging) and `dump-raw.mjs` |
| [`docs/`](docs) | protocol and network setup |

### Probe tools

```sh
npm run build:server
node tools/wifish-probe.mjs --iface <wlan IP> --log raw.bin
node tools/wifish-probe.mjs --iface <wlan IP> --sk 127.0.0.1:<signalk udp port>
node tools/wifish-probe.mjs --iface <wlan IP> --no-keepalive   # passive test
node tools/wifish-probe.mjs --replay raw.bin                   # decode a capture, no device needed
node tools/dump-raw.mjs raw.bin --id 0x270104 --hex
```

## Roadmap

- [x] Validate on hardware: connection, sonar data, settings and depth/temperature output
- [x] Confirm the transducer offset convention (depth reference)
- [ ] Resolve the remaining ❓ fields in the protocol doc (unused by the app, cosmetic)
- [x] Signal K server plugin (TypeScript, vitest)
- [x] Echogram stream and web UI
- [ ] Waypoints (the app syncs them from the Dragonfly over TCP) as Signal K resources

## Legal

Independent interoperability work, not affiliated with or endorsed by Raymarine. This
repository contains no Raymarine code or artwork; the protocol was documented for
interoperability with hardware the author owns. Raymarine, Wi-Fish and Dragonfly are
trademarks of their respective owners.
