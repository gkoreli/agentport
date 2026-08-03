import type { SessionDelegation, SurfaceDescriptor, ToolDefinition } from '@agentport/protocol';

export const WALLET_CHANNEL = 'agentport/wallet/1';

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_TOOLS = 64;

export interface WalletConnectRequest {
  id: string;
  delegate: string;
  surface: Pick<SurfaceDescriptor, 'name' | 'route' | 'context'>;
  tools: ToolDefinition[];
  alwaysAsk: string[];
}

export interface WalletConnectResult {
  agent: string;
  displayName: 'Personal agent';
  delegation: SessionDelegation;
}

export type WalletInbound = {
  e: typeof WALLET_CHANNEL;
  t: 'connect.request';
  request: WalletConnectRequest;
};

export type WalletOutbound =
  | { e: typeof WALLET_CHANNEL; t: 'connect.ack'; id: string }
  | { e: typeof WALLET_CHANNEL; t: 'connect.result'; id: string; result: WalletConnectResult }
  | { e: typeof WALLET_CHANNEL; t: 'connect.error'; id: string; message: string };

interface PostMessageTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

interface PopupHost {
  opener: PostMessageTarget | null;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface BoundWalletRequest {
  /** Derived only from MessageEvent.origin; no payload field can override it. */
  origin: string;
  request: WalletConnectRequest;
  reply(message: WalletOutbound): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWebOrigin(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function isPublicKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function readTool(value: unknown): ToolDefinition | null {
  if (!isRecord(value) || typeof value['name'] !== 'string' || typeof value['description'] !== 'string') return null;
  if (!isRecord(value['inputSchema'])) return null;
  if (value['name'].length === 0 || value['name'].length > 128 || value['description'].length > 4096) return null;
  return {
    name: value['name'],
    description: value['description'],
    inputSchema: value['inputSchema'],
    ...(value['requiresApproval'] === true ? { requiresApproval: true } : {}),
  };
}

/** Rebuild hostile page data before the wallet UI renders or signs anything. */
export function readWalletRequest(value: unknown): WalletConnectRequest | null {
  try {
    if (JSON.stringify(value).length > MAX_MESSAGE_BYTES || !isRecord(value)) return null;
  } catch {
    return null;
  }
  if (typeof value['id'] !== 'string' || value['id'].length === 0 || value['id'].length > 128) return null;
  if (!isPublicKey(value['delegate']) || !isRecord(value['surface'])) return null;

  const rawSurface = value['surface'];
  if (typeof rawSurface['name'] !== 'string' || rawSurface['name'].length === 0 || rawSurface['name'].length > 200) {
    return null;
  }
  if (rawSurface['route'] !== undefined && typeof rawSurface['route'] !== 'string') return null;
  if (rawSurface['context'] !== undefined && !isRecord(rawSurface['context'])) return null;

  if (!Array.isArray(value['tools']) || value['tools'].length > MAX_TOOLS) return null;
  const tools: ToolDefinition[] = [];
  const toolNames = new Set<string>();
  for (const candidate of value['tools']) {
    const tool = readTool(candidate);
    if (!tool || toolNames.has(tool.name)) return null;
    toolNames.add(tool.name);
    tools.push(tool);
  }

  if (!Array.isArray(value['alwaysAsk']) || value['alwaysAsk'].some((name) => typeof name !== 'string')) return null;
  const alwaysAsk = [...new Set(value['alwaysAsk'] as string[])];
  if (alwaysAsk.length > MAX_TOOLS || alwaysAsk.some((name) => name.length === 0 || name.length > 128)) return null;

  return {
    id: value['id'],
    delegate: value['delegate'],
    surface: {
      name: rawSurface['name'],
      ...(typeof rawSurface['route'] === 'string' ? { route: rawSurface['route'] } : {}),
      ...(isRecord(rawSurface['context']) ? { context: rawSurface['context'] } : {}),
    },
    tools,
    alwaysAsk,
  };
}

/**
 * Bind one popup lifetime to the first valid opener request.
 *
 * Before binding, only `host.opener` may speak. After binding, both the exact
 * source object and MessageEvent.origin must match. The payload is rebuilt and
 * carries no trusted origin field; every response uses the bound origin as its
 * explicit targetOrigin.
 */
export function startWalletHandshake(
  onRequest: (request: BoundWalletRequest) => void,
  host: PopupHost = window,
): () => void {
  let bound: { origin: string; source: PostMessageTarget; id: string } | undefined;

  const onMessage = (event: MessageEvent) => {
    if (!host.opener || event.source !== host.opener) return;
    if (bound && (event.source !== bound.source || event.origin !== bound.origin)) return;
    if (!isWebOrigin(event.origin) || !isRecord(event.data)) return;
    if (event.data['e'] !== WALLET_CHANNEL || event.data['t'] !== 'connect.request') return;

    const request = readWalletRequest(event.data['request']);
    if (!request) return;

    const source = event.source as unknown as PostMessageTarget;
    if (bound) {
      if (request.id === bound.id) {
        source.postMessage({ e: WALLET_CHANNEL, t: 'connect.ack', id: request.id }, bound.origin);
      }
      return;
    }

    bound = { origin: event.origin, source, id: request.id };
    const reply = (message: WalletOutbound) => source.postMessage(message, bound!.origin);
    reply({ e: WALLET_CHANNEL, t: 'connect.ack', id: request.id });
    onRequest({ origin: bound.origin, request, reply });
  };

  host.addEventListener('message', onMessage);
  return () => host.removeEventListener('message', onMessage);
}
