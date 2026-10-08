import { EventEmitter } from 'events';

/**
 * In-process event bus. Engine services publish domain events here; the Socket.IO layer
 * and notification service subscribe. Keeps services decoupled from transport.
 */
export type BusEvent =
  | 'price'
  | 'candle'
  | 'signal'
  | 'order'
  | 'trade'
  | 'position'
  | 'portfolio'
  | 'risk'
  | 'exchange-status'
  | 'ai-analysis'
  | 'payment'
  | 'system';

class Bus extends EventEmitter {
  publish(event: BusEvent, payload: unknown) {
    this.emit(event, payload);
  }
}

export const eventBus = new Bus();
eventBus.setMaxListeners(100);
