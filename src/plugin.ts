// Signal K server plugin: Raymarine Wi-Fish / Dragonfly Pro sonar.
// Publishes depth and water temperature and serves the echogram web app's API.

import { Engine } from './engine';
import path from 'node:path';
import { Api } from './api';
import { DisplayStore, VesselStore } from './store';
import { DeviceTransport } from './device';
import { DemoDevice } from './demo';
import { ReplayTransport } from './replay';
import { PLUGIN_ID } from './shared/api';
import type { Delta } from './signalk';
import type { Transport } from './transport';
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
  source?: 'device' | 'demo' | 'replay';
  iface?: string;
  keepalive?: boolean;
  replayFile?: string;
  demoModel?: 'dragonfly' | 'wifish';
  historyColumns?: number;
  emitDepth?: boolean;
  emitTemperature?: boolean;
}

type Next = (err?: unknown) => void;
interface Router { use(fn: (req: IncomingMessage & { path?: string }, res: ServerResponse, next: Next) => void): void }

export const schema = {
  type: 'object',
  properties: {
    source: {
      type: 'string',
      title: 'Data source',
      description: 'device = Wi-Fish / Dragonfly Pro on the Wi-Fi this server is joined to; demo = built-in simulated sonar; replay = raw capture file',
      enum: ['device', 'demo', 'replay'],
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
      enum: ['dragonfly', 'wifish'],
      description: 'dragonfly = CHIRP sonar + DownVision, wifish = DownVision only',
      default: 'dragonfly',
    },
    historyColumns: {
      type: 'number',
      title: 'History columns per channel',
      description: 'Echogram history kept on the server for viewers that open the web app later.',
      default: 1500,
      minimum: 0,
      maximum: 20000,
    },
    emitDepth: { type: 'boolean', title: 'Publish depth', default: true },
    emitTemperature: { type: 'boolean', title: 'Publish water temperature', default: true },
  },
} as const;

/** Transport for the configured source; the real device is the default. */
export function createTransport(cfg: PluginConfig, isReady: () => boolean, log: (m: string) => void): Transport {
  switch (cfg.source) {
    case 'demo':
      return new DemoDevice({ model: cfg.demoModel === 'wifish' ? 'wifish' : 'dragonfly' });
    case 'replay':
      return new ReplayTransport(cfg.replayFile ?? '');
    default:
      return new DeviceTransport({ iface: cfg.iface?.trim() || undefined, keepalive: cfg.keepalive !== false, isReady, log });
  }
}

/** Build the Signal K plugin: runs an Engine for the configured source and serves the web app's API. */
export function plugin(app: ServerApp) {
  let engine: Engine | null = null;
  /** Log through the server's debug logger, if it has one. */
  const debug = (m: string) => app.debug?.(m);
  /** A file in the plugin's data directory, or undefined before the server provides one. */
  const dataFile = (name: string) => () => {
    const dir = app.getDataDirPath?.();
    return dir ? path.join(dir, name) : undefined;
  };
  /** The web app's display units and the vessel settings, saved in the plugin's data directory. */
  const display = new DisplayStore(dataFile('display.json'), debug);
  const vessel = new VesselStore(dataFile('vessel.json'), debug);
  const api = new Api(() => engine, display, vessel);

  /** Show link changes as plugin status; 'offline' (other than after stop) as a plugin error. */
  const status = (link: string, msg: string) => {
    if (link === 'offline' && msg !== 'stopped') app.setPluginError?.(msg);
    else app.setPluginStatus?.(msg);
  };

  return {
    id: PLUGIN_ID,
    name: 'Wi-Fish / Dragonfly sonar',
    description: 'Raymarine Wi-Fish and Dragonfly Pro Wi-Fi sonar: depth, water temperature and live echogram',
    schema: () => schema,

    /** (Re)start with a new transport and engine; failures are reported as a plugin error, never thrown. */
    start(config: PluginConfig = {}) {
      engine?.stop(); // a second start without stop must not leak the first engine's sockets
      engine = null;
      try {
        const cfg: PluginConfig = { ...config };
        if (cfg.source === 'replay' && !cfg.replayFile) cfg.source = 'demo';
        let e: Engine | null = null;
        const transport = createTransport(cfg, () => e?.session.ready ?? false, debug);
        e = new Engine(transport, {
          historyColumns: cfg.historyColumns,
          emitDepth: cfg.emitDepth,
          emitTemperature: cfg.emitTemperature,
          surfaceToTransducerCm: () => vessel.get().surfaceToTransducerCm ?? null,
          onDelta: (d) => app.handleMessage(PLUGIN_ID, d),
          log: debug,
        });
        transport.on('link', status);
        engine = e;
        api.bind();
        e.start();
      } catch (err) {
        // Never throw out of start(): report and stay loaded.
        app.setPluginError?.(`Failed to start: ${(err as Error).message}`);
      }
    },

    /** Detach viewers from the engine, then stop it. */
    stop() {
      const e = engine;
      engine = null;
      api.bind();
      e?.stop();
    },

    /** Mount the API on the plugin's router; requests it does not handle fall through to `next`. */
    registerWithRouter(router: Router) {
      router.use((req, res, next) => {
        const path = req.path ?? new URL(req.url ?? '/', 'http://x').pathname;
        api.handle(req, res, path).then((handled) => { if (!handled) next(); }, next);
      });
    },
  };
}
