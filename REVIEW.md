# Code review: leaner, lighter, better, faster

Date: 2026-10-04. Branch `main` at fa31e6c. Five parallel review passes (server protocol
layer, plugin/engine/API, web app, tests/tooling/packaging, and a dedicated pass on the
"sonar not available" behaviour), every finding re-checked against the source and, where
numbers are quoted, measured on the built `dist/` or `public/` output. Nothing was changed.

## Verdict

The code base is in good shape. The server decode path costs about 2.5 µs per datagram
(0.03 % of one core at Wi-Fish rates), SSE column frames are serialised once for all
viewers, timers and sockets are cleaned up on stop, and the access-level logic matches the
Signal K server source. There is **one real bug** (another sender's data keeps a dead
session alive), **one visual bug** (a CSS colour token in Android byte order), and a set of
worthwhile memory, rendering and test-suite improvements. Most "faster" ideas on the server
are negligible and are listed as rejected so they are not re-investigated.

Baseline measured in this session:

| | |
|---|---|
| Typecheck | clean (src and web) |
| Tests | 199 pass, 16 files, 3.6 s wall |
| Bundle | `app.js` 50.7 kB (18.9 kB gzip), `app.css` 11.0 kB |
| npm package | 46 files, 403 kB packed, 302 kB of which are the two screenshots |
| Server decode | 284 µs per second of Wi-Fish traffic (116 datagrams) |

## 1. Bugs (fix first)

### 1.1 Sonar data from any sender keeps the session alive (device.ts)

`src/device.ts:342` passes every datagram on the data socket to `#rx`, and
`src/device.ts:285-287` does the same for sonar messages on the discovery socket. Neither
checks `rinfo.address` against the locked-on `#service.device`. Reproduced on loopback: with
the locked-on sonar silent and a second sender streaming, the engine published the second
sender's depth, the link stayed `connected`, GIVE_UP never fired, and keepalives and
settings commands kept going to the first sonar's control port. This is what happens when
the unit comes back on a new IP within 20 s, or when two units are in range.

Fix: drop datagrams whose sender is not `#service.device` in both places. The protocol
rejects an announcement unless its sender equals the announced device IP
(`checkService`, `src/sonar4.ts:127`), and control goes to that same IP, so filtering data
on it is consistent with the protocol. The captures in `docs/PROTOCOL.md` §8 do not record
sender addresses, so confirm once on hardware that data arrives from the announced IP.
No test covers this; `test/device.test.ts:145-151` only checks that the second sonar's
announcement is ignored.

### 1.2 `--bg-semi` is an Android `#AARRGGBB` value (style.css)

`web/style.css:4` has `--bg-semi: #d0242328`, copied from the app's `colors.xml`. CSS reads
8-digit hex as `#RRGGBBAA`, so this is red at 16 % opacity. It is used by the gear button
(`web/style.css:56`), which should be the dark background at 82 %. Fix: `#242328d0`.

### 1.3 Malformed first segment allocates, then miscounts (sonar4.ts)

`src/sonar4.ts:411-416`: for `segment === 0` a `Uint8Array(total)` is allocated and stored
before `offset !== filled` is checked, so a segment 0 with a non-zero offset allocates up to
1 KB, is dropped, and increments `dropped` (twice if it replaced a partial). Fix: add
`(s.segment === 0 && s.offset !== 0)` to the early-reject test at line 406. Tests do not
pin `dropped` for this case; the legitimate-restart count at `test/sonar4.test.ts:359` is
preserved.

### 1.4 Test files are never type-checked, and contain three type errors

`tsconfig.json` includes `src` only and `web/tsconfig.json` excludes `test`; vitest strips
types without checking; CI runs `npm test` and `npm run build` but not `npm run typecheck`.
Running `tsc` over `test/` today reports:

- `test/device.test.ts:107,108,180`: `dgram.AddressInfo` does not exist (it is in `node:net`).
- `test/engine.test.ts:273`: `FAKE_CLOCK ... as const` is readonly and not assignable to
  `FakeTimerInstallOpts.toFake` at seven call sites.
- `test/api.test.ts:308`: the fake request lacks `FakeReq`'s index signature; `as never`
  casts downstream hide it.

Fix: a `tsconfig.test.json` covering `src` and `test`, add it to `typecheck`, and run
`typecheck` in CI (about 2.6 s). Fix the three errors.

## 2. Faster

### 2.1 Web: skip the overlay redraw when only columns changed (trace.ts)

`web/src/trace.ts:342-346` runs `#drawEcho()` then `#drawOverlay()` on every dirty frame,
and every live column marks the frame dirty. The overlay (rulers with `shadowBlur = 2`,
about 9 `fillText` and 12 `fillRect` per trace) depends only on window, full window, unit,
offset, depth lines, layout, size and DPR, none of which change with a column. At 12 Hz and
two traces that is roughly 24 shadow-blurred text draws per second that paint the same
pixels. Fix: an overlay key or a separate `#ovDirty` flag set by `#setZoom`, `configure`,
`#resize`, the full-key change and the animation branch. Likely the largest avoidable
per-column cost on phones. Needs a browser profile to quantify; no test covers drawing.

### 2.2 Web: incremental zoom box and backward scrolling (trace.ts)

- `web/src/trace.ts:374` recomputes the whole zoom box (15 % of the width, every row) on
  every column while the main area is shifted incrementally. Measured in Node: a full
  1500×900 fill is 5.5 to 6.2 ms, so the zoom box alone costs about 1.2 ms per column,
  roughly 100× the new main column.
- `web/src/trace.ts:367-371` only takes the incremental path for `shift > 0`, so every step
  of paused backward scrolling (drag, Shift+wheel, arrow keys, scrollbar) is a full redraw.

Fix: mirror the shift for the zoom-box strip and for negative shifts, and `putImageData`
the two or three dirty rectangles instead of one `from..W` rectangle. Moderate risk
(dirty-rect bookkeeping); `columnAt` and `visibleColumns` tests are unaffected.

### 2.3 Web: precompute the row-to-sample index map (trace.ts)

`web/src/trace.ts:396-400` computes `Math.floor((win.top + ((y + 0.5) / H) * span) * k)`
per row per distinct column; the map depends only on window, height, sample count and
`endCm`, which are the same for every column until the range changes. Measured: a full
redraw drops from 5.5 to 3.6 ms (-40 %) with a cached `Int32Array(H)`. Full redraws happen
on every zoom-animation frame, every backward scroll step, every zoom-box update and on
range, palette, speed and resize changes. Low risk. A row-major variant was benchmarked
and is slower in V8; do not try it.

### 2.4 Tests: two real 1.3 s sleeps are 70 % of the suite's wall time (api.test.ts)

`test/api.test.ts:121` and `:213` sleep 1300 ms. The demo reports `connected` on
`setImmediate` and sends a bottom record every 83 ms, so the first depth delta arrives
within about 100 ms. These two tests take 1.4 s and 1.3 s of a 3.6 s suite, and the
`> 5` column count at line 159 is the same kind of wall-clock assumption commit 46fed79
had to patch for macOS. Fix: `await until(() => deltas.length > 0)` (the helper exists at
line 100) and drop the count; the backlog property is already pinned deterministically at
lines 423-433. Suite wall time about 3.6 s to about 1.3 s.

### 2.5 Tests: ten sequential process spawns (tools.test.ts)

`test/tools.test.ts:16-20` spawns Node once per test (75 to 175 ms each, 0.9 s total).
After 2.4 this file is the long pole. Mark the tests `.concurrent` with an async spawn, or
merge the four dump-raw usage-error cases. About 0.9 s to 0.25 s.

### 2.6 Server: backlog sorts the whole history on every stream open (api.ts)

`src/api.ts:166-182` concatenates and sorts both channels' histories, then keeps only the
newest frames that fit 2 MiB. Measured 27 ms per connect at `MAX_HISTORY_COLUMNS`, 1.5 ms
at the default. A two-pointer merge from the newest end stops at the byte budget. Only
matters with a large history setting.

## 3. Lighter

### 3.1 Server history keeps two copies of every column (engine.ts, api.ts)

`src/engine.ts:383-395` stores each `ColumnMessage` with base64 `data`, and
`src/api.ts:154-163` caches the full SSE frame per column in a `WeakMap` keyed by that
object, so the frame lives as long as the history entry. Measured for 800-sample columns:
1.2 KB message plus 1.4 KB frame, against 0.8 KB of raw samples. Default 1500 × 2 columns
is about 7.4 MiB with viewers connected; at the 20 000 maximum about 99 MiB versus 46 MiB
without the frame cache. Relevant on a Raspberry Pi.

Options: (A) keep one serialised form, `{ t, json }`, build the frame at write time by
string concatenation and drop the `WeakMap` (halves memory, keeps the "stringify once"
test); (B) keep raw samples and serialise on demand (a full 2 MiB backlog measured 8 ms per
connect; a third of the memory, but breaks the stringify-once test for the backlog case).
Tests pinning: `test/engine.test.ts:189-205` reads `.data`, `.n`, `.endCm` from history;
`test/api.test.ts:461-467` counts `JSON.stringify` calls.

### 3.2 Idle viewers receive a state frame every second (engine.ts)

`src/engine.ts:138-140` schedules a coalesced state emit on every temperature, error-flag
and system-status datagram, which a real unit and the demo send once a second. Each emit
is a `JSON.stringify` and a 500 to 700 byte write per viewer, and the web app re-runs its
state painting with identical data. Fix: compare the serialised state with the last one
emitted and skip when equal (`Api.bind()` sends a fresh state to new viewers itself). Not
pinned by tests.

### 3.3 Browser keeps up to 20 000 columns per channel regardless of the server (history.ts)

`web/src/history.ts:321` defaults the browser store to `MAX_HISTORY_COLUMNS`, 13× the
server default of 1500, deliberately so a long server history is not cut short. On a phone
this grows to about 36 MiB for two channels after half an hour, on top of two ImageData
buffers of about 5.4 MiB each. Consider sending `historyColumns` in `WifishState` and
sizing the store to it (or a small multiple).

### 3.4 Replay keeps one object and one Buffer view per record (replay.ts)

`src/replay.ts:243-249` pushes every record; at the 256 MB file cap that is about 75 MB on
top of the file buffer. For the 18 k-record capture in `docs/PROTOCOL.md` §8 it is 3 MB,
so this only matters for very large captures. A `Uint32Array` of offsets, or re-walking the
generator each loop, removes it.

### 3.5 Screenshots are 75 % of the npm tarball

`docs/screenshot*.jpg` are 141 kB and 161 kB and must ship (Signal K's app store serves
them from the package). Stripping metadata at quality 80 saves 69 kB (-17 % of the
tarball). Only worth doing when the screenshots are next retaken.

## 4. Leaner

Each of these is dead or duplicated code with no behaviour change and no test impact unless
stated.

- `src/device.ts:308-318` and field `#unreachable` (`:131`): `ifacesFor` returns `[]` only
  for no candidates, and `#open` never opens discovery with none, so this branch is dead
  (the comment says so). About 14 lines.
- `src/plugin.ts:219-224`: `try/catch` around `api.handle(...)`, which is `async` and cannot
  throw synchronously. 5 lines.
- `src/api.ts:351`: `req.on('close', done)` duplicates `res.on('close', done)`; on some Node
  versions `IncomingMessage` 'close' fires after the body is consumed, which would silently
  drop a viewer that is still streaming. Delete it.
- `src/engine.ts:273` and `:370`: `|| this.#stopped` is unreachable after `stop()` removes
  every listener; `:95` `setMaxListeners(0)` serves two listeners per event.
- `src/sonar4.ts:6`: `export { MAX_TRANSDUCER_OFFSET_CM }` has no importer.
- `src/sonar4.ts:349-357, 395, 431` and `src/session.ts:213-228`: `Column.results` is typed
  nullable but every returned column has results; the `!r` check and the two `{ ...col,
  results }` spreads can go.
- `src/sonar4.ts:73-81` `cstr`: build the string from a `subarray` and a control-character
  regex instead of `number[]` → `Uint8Array` → decode. Three fewer lines; tests at
  `test/sonar4.test.ts:120-136, 202-219` still pass.
- `src/session.ts:295-339` `retryPending`: the generic `step` and two `build` closures are
  created per call to share about 12 lines; a `rebuild` on `Pending` makes it one loop.
  Pinned by `test/session.test.ts:147-257` (timing, stale rebuild, `MAX_SENDS`, warn text),
  which should keep passing.
- `src/session.ts:60` `seen` is a `Map` whose counts nobody reads; a `Set` suffices.
  `:57` `sameBytes` can be `Buffer.compare(a, b) === 0`.
- `src/demo.ts:127-138, 168-169`: defensive `Uint8Array.from` copies the session copies
  again anyway.
- `src/engine.ts:394-395`: `historyColumns: 0` still pushes then splices every column.
- `src/store.ts:32` `MAX_SURFACE_TO_TRANSDUCER_CM` is a pure alias used only in that file.
- Web: `web/src/dialogs.ts:30/81` `DialogHandle.open` is never read; `web/src/prefs.ts:411-413`
  `MIN_SPEED`, `MAX_SPEED`, `SETTINGS_TABS` duplicate `clampSpeed` (`geometry.ts:24`) and
  `TABS.length` (`dialogs.ts:220`); `web/src/main.ts:30-37` `stores` duplicates
  `traces[ch].store` and `Object.values(traces)` appears about 14 times; `trace.ts:395`
  `c && have` and `:370` `Number.isInteger(shift)` are always true; `style.css:47, 116, 124`
  restate defaults. Bundle effect of all of these together is under 1 kB raw.
- `tools/wifish-probe.mjs:21-23, 206-217`: a `TIMING` fallback for "older dist builds" that
  cannot trigger in the published package, and a private copy of `candidatesFrom`/`ifacesFor`
  (which also mishandles a null netmask). Import both from `dist/device.js`.
- Tests: `FakeRes`, `req`, `sleep`, `until` exist in both `api.test.ts` and
  `plugin.test.ts`; the bottom-record builder is inlined 28 times although
  `engine.test.ts:274` defines `bottomMsg`; unit and announce datagrams are hand-built 8 and
  4 times; capture-file writers appear 4 times. Moving them into `test/helpers.ts` removes
  about 80 to 100 lines. Pinned incidental values worth deleting or moving to one constants
  test: `session.test.ts:305`, `device.test.ts:174`, `web.test.ts:40`, `sonar4.test.ts:85-87`,
  `api.test.ts:188`.

## 5. Better

### 5.1 Status and lifecycle (server)

- **Lost sonar looks like one never found.** `src/device.ts:364` sets "Sonar offline.
  Looking for a Wi-Fish / Dragonfly" and in the same tick `#open` (`:227`) overwrites it with
  "Looking for a Wi-Fish / Dragonfly". The engine also gets two `searching` events, so two
  `session.reset()` calls and two plugin-status writes. Fix: `#open` should not re-emit
  `searching` when already searching, or take the reason as a parameter. Decide whether a
  lost sounder should be `setPluginError` (today only "no interface" is an error).
- **Configured interface that does not exist.** With `iface` set, `candidatesFrom`
  (`src/device.ts:61`) never consults the OS. Observed: `addMembership` fails with ENODEV, is
  logged once, and the status stays `searching` with no hint; the rescan key never changes,
  so the join is never retried; if an announcement does arrive via another interface the
  control-socket bind fails and the link flaps every 6 s. Fix: check the address exists in
  `os.networkInterfaces()` in `#open` and `#scheduleRetry` with a clear message, like the
  no-interface case; include presence in the rescan key.
- **Quick reboot within 20 s is not a new session.** Same IP and same service means
  `sameService` short-circuits (`:272`), `lost` → `connected` is not "fresh"
  (`src/engine.ts:126`), and settings with a lower seq are rejected until the unit's seq
  catches up (`src/session.ts:179, 197`). The Android app resets its decoders on every
  reconnect. A seq regression right after a `lost` recovery could be treated as a new
  session. Design choice; real boot times make it unlikely.
- **Duplicate null depth after re-acquire.** The new unit's first SYS_SETTINGS triggers
  `#depth(null, true)` (`src/engine.ts:141`) while `#depthPaths` still holds the old
  session's paths. Clear `#depthPaths` in `#clearReadings` when the session resets.
- **Null depth is re-sent every 5 s while bottom lock is lost**, because the throttle's
  heartbeat clause (`src/signalk.ts:218-219`) ignores the value. The comment at
  `src/engine.ts:328-332` says null is sent once; that is only true of the watchdog path.
  Either is acceptable Signal K behaviour; make the comment and the code agree.
- **No permanent 'error' listener on the SSE response** (`src/api.ts:383-399` attaches one
  only while awaiting 'drain'). All writes are guarded by `#alive` and no race was
  constructed, but an unhandled 'error' on a `ServerResponse` would take the server process
  down. One `res.on('error', ...)` in `#stream` is cheap insurance.
- **Rate-limited depth changes wait for the 1 s watchdog.** A change suppressed by the
  200 ms minimum interval is flushed by the next 1000 ms tick (`src/engine.ts:255-263`), so
  latency can approach 1 s. README promises a rate cap, not latency, and
  `test/engine.test.ts` pins the exact sampled values, so change only if wanted.
- `src/api.ts:13-15, 241`: the comment's rationale for the 403 is wrong (on servers without
  per-route access all plugin routes are admin-only); the 403 is defence in depth, and the
  `isReadonly()` check was verified correct against the Signal K server source, including
  anonymous readonly.

### 5.2 Web app

- **Accessibility.** `web/src/dialogs.ts:374, 385, 398` open `role="dialog"` popovers with
  `title: undefined`, so they have no accessible name. `.icon-btn.round[aria-expanded="true"]`
  (`style.css:35`) is styled but `aria-expanded` is never set. `overflowMenu` uses
  `role="menu"` without arrow-key handling. Add `aria-label`s, toggle `aria-expanded` on the
  anchor, and either add arrow keys or use plain buttons.
- **Layout thrash while paused.** `web/src/trace.ts:96` reads `offsetParent` every frame
  for both traces, and `web/src/main.ts:449-464` reads `clientWidth` then writes the thumb
  width, forcing a layout each frame while the scrollbar shows. Use `hidden` and the
  ResizeObserver width instead.
- **Snapshot blocks the main thread.** `web/src/main.ts:548-552` uses `toDataURL` on a
  full-DPR canvas; `toBlob` with an object URL is asynchronous and avoids the base64 copy.
- **Settings popover rebuilds both range selects** (about 25 options each) on every state
  event while open (`web/src/dialogs.ts:366-369`) even when unit and range are unchanged.
- `web/src/main.ts:356-366`: after a double tap `lastTap` is still set, so a third tap
  within 320 ms is another double tap. `web/src/main.ts:820`: `beforeunload` → `closeAll()`
  issues fetches the browser may cancel, so "apply by closing the tab" is nondeterministic.
- Suspected, needs a browser profile: the per-column `drawImage` self-blit plus
  `putImageData` on the same canvas (`trace.ts:372-377`) may force a software canvas; a
  small offscreen strip canvas would keep the main canvas on the GPU path. Also any SSE
  `error` event immediately shows the full "Connecting" overlay (`stream.ts:204-205`); a
  short grace period would avoid flicker on Wi-Fi hiccups.

### 5.3 Tests, CI and packaging

- **`DeviceTransport` is 65 % covered; every other server module is 96 % or more.** The
  separate-data-port socket (`src/device.ts:339-345`), `lost` after QUIET_MS, `searching`
  after GIVE_UP_MS, re-acquire, `#scheduleRetry` and `#rescanInterfaces` never run in tests.
  These are the paths every real user runs. Suggested tests: a loopback sonar announcing a
  different data port; a watchdog test with fake `setInterval` and `performance` but real
  sockets asserting the link sequence and that no handles leak; a sender-filter test for
  bug 1.1; `candidatesFrom` empty → offline → interface appears → searching; a discovery
  bind error; start → stop → start with the real transport.
- **Discovery port chosen at random** (`test/device.test.ts:107, 180`): `+ 1 + random(100)`
  with `reuseAddr: true` means a collision shares datagrams with a stranger instead of
  failing, then times out. Bind a throwaway socket to port 0 and use its port.
- **Two stream loops can hang to the 10 s timeout** (`test/api.test.ts:186, 210`): when the
  stream ends `value` is undefined and the loop spins. Line 146 does it right.
- `@types/node ^22` while `engines.node >= 20`: pin types to `^20` so a Node-22-only API
  fails to compile. No such API is used today.
- `prepare` runs the full build on `npm ci`, so every CI job builds twice (about 3 s × 12
  jobs). Signal K installs with `--ignore-scripts`, so end users are unaffected either way.
  Renaming to `prepack` is optional; README line 108 would need updating.
- `test/tools.test.ts:40-44` rebuilds `dist` only if two of the four files the tools import
  are missing, so locally the tools can be tested against a stale build.
- `package.json:9` `!dist/**/*.map` is redundant (`sourceMap: false`); `!public/*.map` is
  needed for `--watch`.
- `test/signalk.test.ts:4-10` runs 10 001 `expect`s (139 ms); `test/units.test.ts:42-51`
  shows the faster pattern.

## 6. How the plugin behaves when the echo sounder is not available

Traced through the code and exercised against the built `dist/` with a real
`DeviceTransport` on loopback. Overall: nothing throws, nothing leaks, statuses are sane
and deltas go to null once. The exceptions are the items in 1.1 and 5.1.

| Scenario | What happens | Verdict |
|---|---|---|
| Sonar never announces | Discovery socket bound, `searching`, plugin status "Looking for a Wi-Fish / Dragonfly". Interfaces re-read every 5 s and discovery reopened if they change. No deltas (null is not published before a value was). Idle load: a 1 Hz no-op tick, one `getifaddrs` per 5 s, one SSE ping per viewer per 15 s. Web app shows the message, then after 6 s a "Sonar offline" panel with a join-the-Wi-Fi hint. `/api/state` returns `searching`. | Correct |
| No IPv4 interface at all | `offline`, `setPluginError("No IPv4 network interface; join the sonar Wi-Fi")`, retried every 5 s with log deduplication. Observed self-healing when the interface appeared. | Correct |
| Ethernet only, no 192.x | Listens on the Ethernet address; when Wi-Fi comes up the rescan sees the preferred 192.x candidate and rejoins there. | Correct |
| Configured `iface` does not exist | Join fails with ENODEV, logged once, status stays `searching` with no hint, never retried; control-socket bind flaps if an announcement arrives via another interface. | Gap (5.1) |
| Sonar switched off mid-session | After 3 to 4 s `lost` ("Trying to restore connection to the sounder"), depth and temperature published as null once, web readout blanked, "Lost connection" dialog once. Keepalives continue to the old IP. After 20 s `searching`, sockets closed and reopened, session reset; history kept, no gap marker in the trace. Re-acquire on the next announcement; depth published immediately. No handle leaked across the cycle. | Correct, status message overwritten (5.1) |
| Sonar back on a new IP within 20 s | Its announcement is ignored as a second sonar, but its data is accepted and keeps the dead session alive; keepalives go to the old IP. | **Bug (1.1)** |
| Same IP, reboot within 20 s | No session reset; lower settings seq ignored until it catches up. | Limitation (5.1) |
| Bottom lost, unit present | Signal K depth null at once; web readout holds 6 s like the app; temperature and columns continue; link stays `connected`. Clearly distinguishable from link loss. | Correct, well tested |
| Plugin disabled while searching | Every timer, socket and listener released; viewers get `state: null` and "Plugin not running"; `/api/state` 503; immediate re-enable rebinds port 5800 without EADDRINUSE. | Correct |
| Demo / replay | Unaffected; replay's missing-file case maps to `offline` with the reason. | Correct |

Untested today: everything past `connected` in `DeviceTransport` (see 5.3), the empty
canvas and overlay states in the web app (no DOM tests exist for `main.ts`), and
start → stop → start with the real socket.

## 7. Considered and rejected (do not re-investigate)

Server: replacing `DataView` with byte math (decode is 2.5 µs per datagram); a ring buffer
for `#history` (`splice` at 20 000 entries is 4 µs per column); removing `Uint8Array.from`
copies in session and device (replay feeds views into a 256 MB buffer); the per-datagram
guard closure; the 32-entry results cap; merging the three "last data" clocks (device
3 s/20 s, engine 5 s) since the engine watchdog is the only one for demo and replay and
both orders are pinned; batching or corking backlog writes (already one `writev`);
pre-encoding frames to `Buffer`; a binary transport instead of base64 over SSE (needs
server upgrade hooks outside the plugin router); one shared ping timer instead of one per
viewer; a per-IP stream cap; `JsonStore`'s synchronous fs on a rare POST path.

Web: row-major pixel fill (slower in V8); `Uint8Array.fromBase64` (not baseline);
on-demand rAF instead of the permanent loop (idle cost is microseconds); `mangleProps`;
dropping `console.warn`; tree-shaking (only `MIN_RANGE_WINDOW_CM` leaks, about 150 B);
event-listener leaks (none found); reconnect logic (correct and pinned); HiDPI handling
(deliberate and pinned); zoom and scroll math (pinned and read correctly).

Tooling: trimming the CI matrix; adding jsdom for the 1950 lines of DOM code (heavy
dependency, conflicts with "lighter"); removing `dist/demo.js` from the package; the
lockfile (99 packages, no duplicate majors); the four devDependency ranges; the `files`
whitelist; the Node engine floor.

## 8. Suggested order

1. Bugs: 1.1 sender filter (plus its test), 1.2 CSS token, 1.3 assembler reject, 1.4
   test typecheck in CI and the three fixes.
2. Status gaps: lost-sonar message, configured-interface check, `DeviceTransport` tests.
3. Test suite speed: 2.4 and 2.5 (about 3.6 s to about 1.3 s).
4. Web rendering: 2.1, 2.3, then 2.2.
5. Memory: 3.1 (option A), 3.2.
6. Lean sweep in section 4 as one commit, running the full suite after each file.
