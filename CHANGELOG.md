# Changelog

## 0.1.0

- Validated on hardware: Wi-Fi discovery and session keepalive, CHIRP sonar and
  DownVision echograms, depth and water temperature, settings changes and the
  transducer offset convention all confirmed against a real unit.
- Depth ruler always starts at 0, like the Android app (it showed e.g. -0.3 at the top
  with the transducer 0.3 m above the keel). The echogram moves by the transducer
  offset instead: up for above keel, down for below waterline, so the bottom echo
  sits at the displayed depth.
- Fix the web app icon missing from the Signal K admin web app list: `appIcon` is
  resolved relative to `public/`, so it now points to `./icon.svg`.
- Signal K server plugin (TypeScript): discovers a Wi-Fish / Dragonfly Pro on the
  Wi-Fi, keeps the session alive and publishes `environment.depth.belowTransducer`
  (plus `belowSurface` / `belowKeel` when a transducer offset is set) and
  `environment.water.temperature`.
- "Wi-Fish Sonar" web app with the Android app's sonar screen: scrolling CHIRP sonar
  and DownVision echograms (split or single), depth ruler, depth and water
  temperature readout, pause and history scrolling, pinch/wheel zoom with zoom box,
  A-scope, depth lines, the app's nine palettes, snapshots, and trace point details.
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
