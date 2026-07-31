import type { Frame } from './messages.js';

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

export function decodeFrame(data: string): Frame {
  const parsed: unknown = JSON.parse(data);
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Frame).t !== 'string') {
    throw new Error('malformed frame');
  }
  return parsed as Frame;
}

/** Minimal promise handle used by the request/response paths. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

type Listener<T> = (value: T) => void;

/** Tiny typed event emitter; avoids a Node dependency in browser code. */
export class Emitter<Events extends Record<string, unknown>> {
  #listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => set!.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, value: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) (listener as Listener<Events[K]>)(value);
  }
}
