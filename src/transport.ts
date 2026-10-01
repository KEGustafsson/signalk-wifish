import type { EventEmitter } from 'node:events';

/**
 * offline    no usable network interface or socket (message says why); retrying
 * searching  listening for the sonar's discovery announcement
 * connecting announcement seen, keepalive running, waiting for sonar data
 * connected  sonar data is flowing
 * lost       was connected, no data for a few seconds; still trying
 */
export type LinkState = 'offline' | 'searching' | 'connecting' | 'connected' | 'lost';

export interface TransportEvents {
  datagram: [Uint8Array];
  link: [LinkState, string];
}

/** Where Sonar4 datagrams come from and where commands go. */
export interface Transport extends EventEmitter<TransportEvents> {
  readonly kind: 'device' | 'demo' | 'replay';
  /** False when commands can't reach a device (passive mode, replay). */
  readonly canSend: boolean;
  start(): void;
  stop(): void;
  send(b: Uint8Array): void;
}
