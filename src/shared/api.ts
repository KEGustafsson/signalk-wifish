// Messages between the plugin and the web app. Shared by both builds.

import type { DepthUnitId, TempUnit } from './units';

export const PLUGIN_ID = 'signalk-wifish';
/** API root, relative to the server origin. */
export const API_BASE = `/plugins/${PLUGIN_ID}/api`;

/**
 * offline    no usable network interface or socket (message says why); retrying
 * searching  listening for the sonar's discovery announcement
 * connecting announcement seen, keepalive running, waiting for sonar data
 * connected  sonar data is flowing
 * lost       was connected, no data for a few seconds; still trying
 */
export type LinkState = 'offline' | 'searching' | 'connecting' | 'connected' | 'lost';

/** Where the plugin's datagrams come from (plugin option `source`, transport `kind`, state `source`). */
export const SOURCES = ['device', 'demo', 'replay'] as const;
export type SourceKind = (typeof SOURCES)[number];
/** Built-in demo sonar models: 'dragonfly' = CHIRP sonar + DownVision, 'wifish' = DownVision only. */
export const DEMO_MODELS = ['dragonfly', 'wifish'] as const;
export type DemoModel = (typeof DEMO_MODELS)[number];

/** Echogram columns kept per channel on the server (plugin option `historyColumns`) and at most per viewer. */
export const DEFAULT_HISTORY_COLUMNS = 1500;
export const MAX_HISTORY_COLUMNS = 20_000;

export const CHANNELS = ['sonar', 'downvision'] as const;
export type ChannelName = (typeof CHANNELS)[number];
/** Ping-results channel code per name (sonar4 ping results off 95). */
export const CHANNEL_CODE: Readonly<Record<ChannelName, 0 | 1>> = { sonar: 0, downvision: 1 };
/** Channel name for a ping-results channel code. */
export const channelByCode = (code: 0 | 1): ChannelName => CHANNELS[code];
/** True for 'sonar' or 'downvision'. */
export const isChannelName = (v: unknown): v is ChannelName => (CHANNELS as readonly unknown[]).includes(v);

export interface ChannelSettingsView {
  configIndex: number;
  name: string;
  rangeAuto: boolean;
  rangeShallowCm: number;
  rangeDeepCm: number;
  gainAuto: boolean;
  gain: number;
  contrastAuto: boolean;
  contrast: number;
  noiseFilterAuto: boolean;
  noiseFilter: number;
}

export interface WifishState {
  /** Identifies the plugin run (engine instance); a change means column numbering restarted. */
  epoch: string;
  source: SourceKind;
  link: LinkState;
  message: string;
  /** Settings can be sent (false in passive mode and for replays). */
  canControl: boolean;
  unit: { type: number; model: string; name: string; serial: string; wifish: boolean } | null;
  softwareVersion: string | null;
  /** Bottom depth as reported (offset applied by the device), cm; null = no bottom lock. */
  depthCm: number | null;
  waterTempCentiC: number | null;
  lowVoltage: boolean;
  system: { transducerOffsetCm: number; depthUnit: number; simulator: boolean } | null;
  channels: Record<ChannelName, ChannelSettingsView | null>;
  /** Channels that have produced data. */
  active: Record<ChannelName, boolean>;
  /** Columns the server keeps per channel (plugin option `historyColumns`). */
  historyColumns: number;
}

/**
 * Display units picked in the web app. The plugin keeps them for every viewer, so the
 * choice is the same on every browser and device and survives restarts. A missing key
 * has not been picked yet (the viewer uses its own default).
 */
export interface DisplayPrefs {
  /** null = follow the sonar's own depth unit. */
  depthUnit?: DepthUnitId | null;
  tempUnit?: TempUnit;
}

/**
 * Vessel settings the sonar does not hold, kept by the plugin like the display units.
 * The sonar stores one transducer offset, to the waterline or to the keel; when it is set
 * to the keel (or not set), this distance lets the plugin publish depth below surface too.
 */
export interface VesselSettings {
  /** Waterline to transducer, cm (0..300); null or missing = not set. */
  surfaceToTransducerCm?: number | null;
}

/** One echogram column, sent as SSE event "col". */
export interface ColumnMessage {
  ch: ChannelName;
  /** Column number, increasing per channel from plugin start. */
  n: number;
  /** Unix ms. */
  t: number;
  /** Default view window below the transducer, cm. Samples span 0..endCm. */
  startCm: number;
  endCm: number;
  /** Bottom below the transducer when this column arrived, cm (null = no lock). */
  bottomCm: number | null;
  waterTempCentiC: number | null;
  /** base64 samples, one byte each. */
  data: string;
}

export type ChannelPatch = Partial<Omit<ChannelSettingsView, 'configIndex' | 'name'>>;
export interface SystemPatch { transducerOffsetCm?: number; simulator?: boolean }
