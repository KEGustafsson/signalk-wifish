# Changelog

## Unreleased

### Fixed

- Depth readout showed some values one tenth too low (2.30 m as 2.2 m): a floating-point
  rounding error in the truncation to tenths.
- Web app was admin-only on current Signal K servers: its routes are now registered at
  readonly (viewing) and readwrite (changing settings).
- `replay` without a file reports an error instead of silently running the demo.
- Interface selection: every candidate interface on the sonar's subnet is joined (all
  of them when none matches, e.g. a `/32` address), so overlapping subnets and the
  `/32` setup in docs/network-setup.md work without the iface option.
- Replay loops reset the session; the event stream reconnects after a 503/502.
- Browser default units were uploaded as if the viewer had picked them.
- Echogram: incremental redraw on HiDPI displays, negative depths clamped,
  overlapping ping segments dropped, traces aligned by time when scrolled, the
  scrollbar reaches the oldest column, wheel `deltaMode` normalised, feet range
  picker cap visible.
- Signal K output: no duplicate `null` delta after a lost link; heartbeats are
  timer-driven (depth every 5 s, temperature every 10 s even when unchanged).
- Range limits 0..400 m, with Deep at least 30 cm below Shallow (the smallest gap between
  two presets, 5 ft to 6 ft); a settings retry rebuilds its command
  on the sonar's newer seq.
- Accessibility of the gear button and the history scrollbar (keyboard, labels).
- `tools/wifish-probe.mjs` exits with a message, not a stack trace, on a bad `--log`
  or `--replay` path; `tools/dump-raw.mjs --id ''` is a usage error.

### Changed

- Errors are logged through the server's error log.
- SSE backlog for a new viewer capped at about 2 MiB.
- Sourcemaps dropped from the production bundle.
- CI runs once per PR (push only on `main` and tags) and tests Node 20 as well.

### Internal

- Shared constants (units, sources, channels, device timing, used by the probe too).
- Tests for the device transport, replay, plugin, CLI tools, trace geometry and prefs.

## 0.1.0

- `tools/wifish-probe.mjs --sk` published the depth the unit reports as
  `environment.depth.belowTransducer`, which is only right when the transducer
  offset is 0. It now reads the offset from the unit's system settings and uses the
  same paths as the plugin (`belowKeel` / `belowSurface` for a non-zero offset),
  clearing a path that stops applying when the offset changes.
- Protocol notes: the ❓ fields a Wi-Fish shows are resolved from captures of a real
  unit (firmware 13.31) and marked 📡 — supply voltage and its low/high marks in the
  environment message (cross-checked against the boat's battery monitor), the device
  serial in every message header, the firmware version in the discovery message, the
  channel in the bottom record, the copy of the channel settings each ping result
  carries, the discovery service name, and the four message types the app ignores
  (transducer descriptor, settings limits, preset table, recorder status). A second
  client is confirmed to work alongside the plugin. What is still open needs a
  Dragonfly and is listed in PROTOCOL.md §7.
- Validated on hardware: Wi-Fi discovery and session keepalive, CHIRP sonar and
  DownVision echograms, depth and water temperature, settings changes and the
  transducer offset convention all confirmed against a real unit.
- Depth ruler always starts at 0, like the Android app (it showed e.g. -0.3 at the top
  with the transducer 0.3 m above the keel). The echogram moves by the transducer
  offset instead: up for above keel, down for below waterline, so the bottom echo
  sits at the displayed depth.
- Signal K server plugin (TypeScript): discovers a Wi-Fish / Dragonfly Pro on the
  Wi-Fi, keeps the session alive and publishes `environment.depth.belowTransducer`
  (plus `belowSurface` / `belowKeel` when a transducer offset is set) and
  `environment.water.temperature`.
- Depth below surface and below keel together: the unit holds one transducer offset,
  to the waterline or to the keel. With it set to the keel (or 0), *Settings →
  Waterline to transducer* in the web app gives the distance the unit lacks, and the
  plugin publishes `environment.depth.belowSurface` from it. The offsets are published
  as `surfaceToTransducer` and `transducerToKeel` (positive downwards, as Signal K and
  the derived-data plugin use them). The distance is kept in the plugin's data
  directory (`vessel.json`) and shared by every viewer.
- "Wi-Fish Sonar" web app with the Android app's sonar screen: scrolling CHIRP sonar
  and DownVision echograms (split or single), depth ruler, depth and water
  temperature readout, pause and history scrolling, pinch/wheel zoom with zoom box,
  A-scope, depth lines, the app's nine palettes, snapshots, and trace point details.
  Its icon shows in the Signal K admin web app list (`appIcon` is resolved relative
  to `public/`, so it points to `./icon.svg`).
- Sonar settings like the app (Sensitivity: gain, contrast, noise filter with Auto;
  Range: auto, shallow, deep; Options: palette, depth lines, A-scope) and main
  settings (transducer depth, depth and temperature units, simulator), sent to the
  sonar as read-modify-write settings messages.
- Built-in demo sonar and raw-capture replay for trying the app without hardware.
- Protocol notes extended with the channel and system settings layouts, vertical
  scale of ping columns, low-voltage flag and software version.
- Behaviour aligned with the Android app after a multi-agent review: keepalive
  reports "connected" only after the unit id and all 32 ping configurations;
  ping data and results pair in either order; depth readout held 6 s after a
  lost bottom and refreshed at most once per second; range snapped to the depth
  unit's presets and re-sent on a unit change; lost connection blanks depth and
  temperature and returns to the connecting screen.
- Hardening: JSON-only settings API (no cross-site form posts), capped event
  streams with per-viewer buffer limits, stricter message validation,
  incremental echogram rendering, keyboard and screen-reader support in dialogs.
- Depth and temperature units picked in the web app are kept by the plugin and shared
  by every viewer, so the choice is remembered across browsers, devices and restarts.
- Settings changes are confirmed against the sonar's broadcasts: a lost command is
  resent, and one the sonar does not apply falls back to its own values instead of
  showing a setting the sonar never took.
- Signal K plugin CI workflow; tests moved to vitest.
- Protocol documentation, probe and raw-capture tools.
