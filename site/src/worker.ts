export { RelayDurableObject } from './relay-do.js';

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  RELAY: DurableObjectNamespace;
}

/**
 * One Worker serves the whole demo: the static surfaces and the relay they
 * connect to, on one origin. That means `wss://` comes free and there is no
 * CORS or mixed-content story to get wrong.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/relay') {
      // A single global relay instance. Sharding by user key is the obvious
      // next step; at demo scale one object is correct and simpler to reason
      // about, since sessions must see each other's presence.
      const id = env.RELAY.idFromName('global');
      return env.RELAY.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
