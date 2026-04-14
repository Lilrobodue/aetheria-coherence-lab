// streams/event-bus.js
// Internal pub/sub replacing LSL. All inter-module communication flows through here.
// Uses EventTarget for zero-dependency pub/sub with sub-millisecond timestamps.

export class EventBus extends EventTarget {
  constructor() {
    super();
    this._subscriptionCount = 0;
  }

  publish(streamName, payload) {
    this.dispatchEvent(new CustomEvent(streamName, {
      detail: { ...payload, timestamp: performance.now() / 1000 }
    }));
  }

  subscribe(streamName, handler) {
    const wrapped = (e) => handler(e.detail);
    this.addEventListener(streamName, wrapped);
    this._subscriptionCount++;
    return () => {
      this.removeEventListener(streamName, wrapped);
      this._subscriptionCount--;
    };
  }

  get subscriptionCount() {
    return this._subscriptionCount;
  }
}

export const bus = new EventBus();
