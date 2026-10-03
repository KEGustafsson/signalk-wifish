import type { EventEmitter } from 'node:events';
import type { LinkState, SourceKind } from './shared/api';

export type { LinkState } from './shared/api';

export interface TransportEvents {
  datagram: [Uint8Array];
  link: [LinkState, string];
}

/** Where Sonar4 datagrams come from and where commands go. */
export interface Transport extends EventEmitter<TransportEvents> {
  readonly kind: SourceKind;
  /** False when commands can't reach a device (passive mode, replay). */
  readonly canSend: boolean;
  start(): void;
  stop(): void;
  send(b: Uint8Array): void;
}
