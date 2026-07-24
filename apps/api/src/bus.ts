import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@playroom/shared';

// ADR-002: in-process fan-out. A single emitter, keyed by room_id, is the whole
// bus. It lives behind this narrow publish/subscribe seam so the eventual swap to
// Redis pub/sub touches only this file — not the room or send-path code.
export class RoomBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many sockets may watch one room; do not cap listeners.
    this.emitter.setMaxListeners(0);
  }

  publish(roomId: string, event: ServerEvent): void {
    this.emitter.emit(roomId, event);
  }

  subscribe(roomId: string, listener: (event: ServerEvent) => void): () => void {
    this.emitter.on(roomId, listener);
    return () => this.emitter.off(roomId, listener);
  }
}
