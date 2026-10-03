// Signal K server plugin: Raymarine Wi-Fish / Dragonfly Pro sonar.
// Publishes depth and water temperature and serves the echogram web app's API.

import { Engine } from './engine';
import path from 'node:path';
import { Api } from './api';
import { DisplayStore, VesselStore } from './store';
import { DeviceTransport } from './device';
import { DemoDevice } from './demo';
import { ReplayTransport } from './replay';
import { DEFAULT_HISTORY_COLUMNS, DEMO_MODELS, MAX_HISTORY_COLUMNS, PLUGIN_ID, SOURCES, type DemoModel, type LinkState, type SourceKind } from './shared/api';
import type { Delta } from './signalk';
import type { Transport } from './transport';
import { errorMessage } from './util';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** The parts of the Signal K ServerAPI this plugin uses. */
export interface ServerApp {
  handleMessage(id: string, delta: Delta): void;
  setPluginStatus?(msg: string): void;
  setPluginError?(msg: string): void;
  debug?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
  /** The plugin's own data directory (provided by the Signal K server once the plugin is registered). */
  getDataDirPath?(): string;
}

export interface PluginConfig {
  source?: SourceKind;
  iface?: string;
  keepalive?: boolean;
  replayFile?: string;
  demoModel?: DemoModel;
  historyColumns?: number;
  emitDepth?: boolean;
  emitTemperature?: boolean;
}

type Next = (err?: unknown) => void;
type Handler = (req: IncomingMessage & { path?: string }, res: ServerResponse, next: Next) => void;
/** Access level of a route registered through `Router.access` (Signal K's RouteAccessLevel). */
export type AccessLevel = 'readonly' | 'readwrite';
/** The routes `Router.access(level)` registers (Express methods; returns the registrar for chaining). */
export interface AccessRouter {
  get(path: string, ...handlers: Handler[]): unknown;
  post(path: string, ...handlers: Handler[]): unknown;
}
/**
 * The Express router Signal K mounts at /plugins/<id>. Routes registered on it directly are
 * admin-only; `access(level)` (Signal K ≥ 2.33) opens a route to readonly or readwrite users.
 * Older servers, the dev server and tests have no `access`.
 */
export interface Router {
  use(...handlers: Handler[]): unknown;
  access?(level: AccessLevel): AccessRouter;
}

/** API routes a readonly user may GET, and a readwrite user may POST (Express path syntax). */
export const READONLY_GETS = ['/api/state', '/api/display', '/api/vessel', '/api/stream'] as const;
export const READWRITE_POSTS = ['/api/channel/:channel', '/api/system', '/api/display', '/api/vessel'] as const;

export const schema = {
  type: 'object',
  properties: {
    source: {
      type: 'string',
      title: 'Data source',
      description: 'device = Wi-Fish / Dragonfly Pro on the Wi-Fi this server is joined to; demo = built-in simulated sonar; replay = raw capture file',
      enum: SOURCES,
      default: 'device',
    },
    iface: {
      type: 'string',
      title: 'Wi-Fi interface address',
      description: 'Local IPv4 address on the sonar Wi-Fi. Empty = pick the 192.x address on the sonar subnet, like the app.',
      default: '',
    },
    keepalive: {
      type: 'boolean',
      title: 'Control the sonar',
      description: 'Send keepalives and settings changes. Off = passive listener (the sonar may stop sending without a keepalive).',
      default: true,
    },
    replayFile: {
      type: 'string',
      title: 'Replay file',
      description: 'Absolute path of a raw capture made with tools/wifish-probe.mjs --log (source = replay).',
      default: '',
    },
    demoModel: {
      type: 'string',
      title: 'Demo model',
      enum: DEMO_MODELS,
      description: 'dragonfly = CHIRP sonar + DownVision, wifish = DownVision only',
      default: 'dragonfly',
    },
    historyColumns: {
      type: 'number',
      title: 'History columns per channel',
      description: 'Echogram history kept on the server for viewers that open the web app later.',
      default: DEFAULT_HISTORY_COLUMNS,
      minimum: 0,
      maximum: MAX_HISTORY_COLUMNS,
    },
    emitDepth: { type: 'boolean', title: 'Publish depth', default: true },
    emitTemperature: { type: 'boolean', title: 'Publish water temperature', default: true },
  },
} as const;

/** Loggers a transport gets: diagnostics and failures. */
export interface Loggers { log: (m: string) => void; error: (m: string) => void }

const isDemoModel = (v: unknown): v is DemoModel => (DEMO_MODELS as readonly unknown[]).includes(v);

/** Transport for the configured source; the real device is the default. */
export function createTransport(cfg: PluginConfig, isReady: () => boolean, { log, error }: Loggers): Transport {
  switch (cfg.source) {
    case 'demo':
      return new DemoDevice({ model: isDemoModel(cfg.demoModel) ? cfg.demoModel : 'dragonfly' });
    case 'replay':
      return new ReplayTransport(cfg.replayFile ?? '');
    default:
      return new DeviceTransport({ iface: cfg.iface?.trim() || undefined, keepalive: cfg.keepalive !== false, isReady, log, error });
  }
}

/** Build the Signal K plugin: runs an Engine for the configured source and serves the web app's API. */
export function plugin(app: ServerApp) {
  let engine: Engine | null = null;
  /** Log through the server's debug logger, if it has one. */
  const debug = (m: string) => app.debug?.(m);
  /** Report a failure through the server's error logger, else its debug logger. */
  const error = (m: string) => (app.error ? app.error(m) : app.debug?.(m));
  /** A file in the plugin's data directory, or undefined before the server provides one. */
  const dataFile = (name: string) => () => {
    const dir = app.getDataDirPath?.();
    return dir ? path.join(dir, name) : undefined;
  };
  /** The web app's display units and the vessel settings, saved in the plugin's data directory. */
  const display = new DisplayStore(dataFile('display.json'), { debug, error });
  const vessel = new VesselStore(dataFile('vessel.json'), { debug, error });
  const api = new Api(() => engine, display, vessel, { error });

  /** Show link changes as plugin status; 'offline' (other than after stop) as a plugin error. */
  const status = (link: LinkState, msg: string) => {
    if (link === 'offline' && msg !== 'stopped') app.setPluginError?.(msg);
    else app.setPluginStatus?.(msg);
  };

  /** Stop the engine (if any) and detach viewers from it; they get state null. */
  const shutdown = () => {
    const e = engine;
    engine = null;
    api.bind();
    e?.stop();
  };

  return {
    id: PLUGIN_ID,
    name: 'Wi-Fish / Dragonfly sonar',
    description: 'Raymarine Wi-Fish and Dragonfly Pro Wi-Fi sonar: depth, water temperature and live echogram',
    schema: () => schema,

    /** (Re)start with a new transport and engine; failures are reported as a plugin error, never thrown. */
    start(config: PluginConfig = {}) {
      shutdown(); // a second start without stop must not leak the first engine's sockets
      try {
        const cfg: PluginConfig = { ...config };
        if (cfg.source === 'replay') {
          const file = cfg.replayFile?.trim() ?? '';
          // Not a silent fallback to the demo: the user picked a replay and must see why none plays.
          if (!file) return app.setPluginError?.('Replay file not set (Data source = replay)');
          if (!path.isAbsolute(file)) return app.setPluginError?.(`Replay file must be an absolute path: ${file}`);
          cfg.replayFile = file;
        }
        let e: Engine | null = null;
        const transport = createTransport(cfg, () => e?.session.ready ?? false, { log: debug, error });
        e = new Engine(transport, {
          historyColumns: cfg.historyColumns,
          emitDepth: cfg.emitDepth,
          emitTemperature: cfg.emitTemperature,
          surfaceToTransducerCm: () => vessel.get().surfaceToTransducerCm ?? null,
          onDelta: (d) => app.handleMessage(PLUGIN_ID, d),
          log: debug,
          error,
        });
        transport.on('link', status);
        engine = e;
        api.bind();
        e.start();
      } catch (err) {
        // Never throw out of start(): report and stay loaded, with no engine for viewers.
        const msg = errorMessage(err);
        try { shutdown(); } catch (e2) { error(`stopping after a failed start: ${errorMessage(e2)}`); }
        error(`Failed to start: ${msg}`);
        app.setPluginError?.(`Failed to start: ${msg}`);
      }
    },

    /**
     * Detach viewers from the engine, then stop it. Event streams stay open on purpose (not
     * api.close()): the server restarts the plugin on a settings change and the viewers pick the
     * new engine up from the 'reset' / 'state' events instead of reconnecting.
     */
    stop() {
      shutdown();
    },

    /**
     * Mount the API on the plugin's router. With `router.access` (Signal K ≥ 2.33) the GETs are
     * open to readonly users and the POSTs to readwrite users, each on its own route; without it
     * one catch-all handles everything (admin-only under an older Signal K) and requests it does
     * not handle fall through to `next`.
     */
    registerWithRouter(router: Router) {
      /** Handler for one route (`fixed` path) or for any path (from the request). */
      const route = (fixed?: string): Handler => (req, res, next) => {
        const p = fixed ?? req.path ?? new URL(req.url ?? '/', 'http://x').pathname;
        let result: Promise<boolean>;
        try {
          result = api.handle(req, res, p);
        } catch (e) {
          result = Promise.reject(e);
        }
        result.then((handled) => { if (!handled) next(); }, (e) => {
          // Not Express's default handler (an HTML page, or the server's own error format): a plain 500.
          error(`${req.method ?? 'GET'} ${p}: ${errorMessage(e)}`);
          if (res.headersSent) { res.end(); return; }
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ error: 'internal error' }));
        });
      };
      if (typeof router.access === 'function') {
        const ro = router.access('readonly');
        for (const p of READONLY_GETS) ro.get(p, route(p));
        const rw = router.access('readwrite');
        for (const p of READWRITE_POSTS) rw.post(p, p.includes(':') ? route() : route(p));
      } else {
        router.use(route());
      }
    },
  };
}
