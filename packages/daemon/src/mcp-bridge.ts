import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { createLogger, toErr, type Logger, type LogSink, type ToolDefinition } from '@agentport/protocol';

/** MCP tool names are stricter than ours; `a.b.c` becomes `a_b_c`. */
export function mcpToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

export type ToolInvoker = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export interface McpBridgeOptions {
  sink?: LogSink;
}

interface Registration {
  token: string;
  tools: ToolDefinition[];
  invoke: ToolInvoker;
  /** mcp-safe name -> original name */
  names: Map<string, string>;
  mcp: McpServer;
  transport: StreamableHTTPServerTransport;
  ready: Promise<void>;
  /** The agent's MCP client completed `initialize` against this endpoint. */
  initialized: boolean;
  /** ...and asked what tools exist — the moment the lent toolset became real. */
  listed: boolean;
  /** What the client said it was, for the log line that joins the two sides. */
  client?: string;
}

/** What the agent's MCP client has actually done with a registration. */
export interface BridgeHealth {
  registered: boolean;
  initialized: boolean;
  listed: boolean;
  client?: string;
}

/**
 * Token-scoped, loopback-only MCP adapter for one attachment's capabilities.
 *
 * Protocol framing, schema validation, request cancellation, and transport
 * teardown belong to the official MCP SDK. AgentPort owns only the bearer
 * boundary and the mapping from a granted tool name to its surface invoker.
 *
 * Reference implementation:
 * https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x/src/server
 *
 * WHICH MCP THIS SPEAKS, VERIFIED RATHER THAN ASSUMED (2026-08-20). The
 * consumer of this server is the MCP client inside the ACP agent — for the
 * default runtime, the client bundled in `@anthropic-ai/claude-agent-sdk`,
 * whose bundle carries the protocol dialects `2025-06-18` and `2025-11-25`
 * and nothing newer. This server runs `@modelcontextprotocol/sdk` 1.30.0 —
 * npm's `latest` — whose newest dialect is `2025-11-25` with negotiation back
 * to 2024-10-07. The 2026-07-28 MCP revision (initialize removed,
 * `server/discover`, `resultType`, MRTR replacing server-initiated
 * elicitation) exists in NO published SDK on either side of this connection,
 * so "cut the bridge over" is not currently an action: both ends already
 * speak the newest dialect that ships. MRTR is unreachable for the same
 * reason, and this bridge declares no elicitation capability anyway — the
 * ask/approval round-trip is ACP-level, judged by `AttachmentAuthority`.
 *
 * THE FAILURE THAT MUST BE LOUD instead: when the ecosystem does move, the
 * first symptom of a dialect mismatch is an agent whose MCP client
 * initializes and then never lists tools — a lent toolset that silently does
 * not exist, indistinguishable from a site that lent nothing. `health()`
 * exists so the runtime can SAY that (see `AcpRuntime`), and the cutover
 * plan is a dependency bump gated on the bundled client actually moving,
 * announced by that same health signal going red in `runtime:check`'s happy
 * path if the two SDKs ever stop overlapping.
 */
export class McpBridge {
  #server: HttpServer | undefined;
  #port = 0;
  #sessions = new Map<string, Registration>();
  #log: Logger;

  constructor(options: McpBridgeOptions = {}) {
    this.#log = createLogger('daemon.mcp', { sink: options.sink });
  }

  async start(): Promise<void> {
    if (this.#server) return;
    const server = createServer((req, res) => {
      void this.#handle(req, res).catch((err: unknown) => {
        this.#log.error('MCP request handler failed', { err, data: { method: req.method, url: req.url } });
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        if (!res.writableEnded) {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }));
        }
      });
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    this.#port = typeof address === 'object' && address ? address.port : 0;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    for (const registration of this.#sessions.values()) {
      await registration.ready;
      // McpServer owns its transport after connect() and closes it here.
      await registration.mcp.close();
    }
    this.#sessions.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  register(sessionId: string, tools: ToolDefinition[], invoke: ToolInvoker): { url: string; token: string } {
    const token = randomBytes(24).toString('hex');
    const names = new Map(tools.map((tool) => [mcpToolName(tool.name), tool.name]));
    const mcp = new McpServer(
      { name: 'agentport-surface', version: '0.0.1' },
      // listChanged is what makes a live `grant.update` visible to the agent:
      // update() below swaps the tool set in place and notifies, so the agent
      // re-lists against the same URL and the same token.
      { capabilities: { tools: { listChanged: true } } },
    );
    const transport = new StreamableHTTPServerTransport({
      // One MCP client belongs to one token-scoped AgentPort attachment. Its
      // stateful transport must outlive individual HTTP requests so a later
      // notifications/cancelled reaches the original request controller.
      sessionIdGenerator: () => randomBytes(18).toString('hex'),
      enableJsonResponse: true,
    });
    const registration: Registration = {
      token,
      tools,
      invoke,
      names,
      mcp,
      transport,
      ready: Promise.resolve(),
      initialized: false,
      listed: false,
    };
    // The SDK's own initialization hook, not a transport sniff: it fires after
    // version negotiation succeeded, which is exactly the boundary a dialect
    // mismatch fails at.
    mcp.oninitialized = () => {
      registration.initialized = true;
      const version = mcp.getClientVersion();
      if (version) registration.client = `${version.name} ${version.version}`;
      this.#log.info('MCP client initialized against the lent toolset', {
        sessionId,
        data: { client: registration.client },
      });
    };
    this.#installHandlers(sessionId, registration);
    registration.ready = mcp.connect(transport);
    this.#sessions.set(sessionId, registration);
    // The wire session id is client-chosen; as a raw path segment, ids like
    // "." or ".." would vanish under URL normalization and route wrong. Hex
    // is immune to every path metacharacter, and deterministic — no second
    // index needed. #handle looks registrations up by the hex form.
    const path = Buffer.from(sessionId, 'utf8').toString('hex');
    return { url: `http://127.0.0.1:${this.#port}/mcp/${path}`, token };
  }

  /**
   * Replace one attachment's tool set in place (v7, `grant.update`).
   *
   * TOKEN-PRESERVING on purpose: the agent was handed this registration's URL
   * and bearer at `session/new`, so the update must happen underneath that
   * endpoint rather than minting a fresh one the agent has never heard of.
   * The list handler reads `registration.tools` live; `sendToolListChanged`
   * is how the agent learns to re-list. Throws when the session was never
   * registered or the notification cannot be delivered — the caller treats
   * that as the runtime failing to adopt the grant, and keeps the old one.
   */
  update(sessionId: string, tools: ToolDefinition[]): void {
    const registration = this.#sessions.get(sessionId);
    if (!registration) throw new Error('no MCP registration for this session');
    registration.tools = tools;
    registration.names = new Map(tools.map((tool) => [mcpToolName(tool.name), tool.name]));
    registration.mcp.sendToolListChanged();
    this.#log.info('MCP tool set updated', { sessionId, data: { toolCount: tools.length } });
  }

  async unregister(sessionId: string): Promise<void> {
    const registration = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    if (!registration) return;
    await registration.ready;
    await registration.mcp.close();
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Path segments are the hex form minted in register(); decode back to
    // the session id the registration map is keyed by.
    const hexPath = /^\/mcp\/([0-9a-f]+)(?:[/?]|$)/.exec(req.url ?? '')?.[1];
    const sessionId = hexPath && hexPath.length % 2 === 0
      ? Buffer.from(hexPath, 'hex').toString('utf8')
      : undefined;
    const registration = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (!registration) return void res.writeHead(404).end('no such session');
    if (req.headers.authorization !== `Bearer ${registration.token}`) {
      return void res.writeHead(401).end('bad token');
    }
    if (req.method !== 'POST') return void res.writeHead(405).end('post only');

    await registration.ready;
    await registration.transport.handleRequest(req, res);
  }

  /**
   * What the agent's MCP client has done with a session's lent tools.
   *
   * `listed: false` after a completed turn means the lent toolset does not
   * exist from the agent's point of view — the invisible-diminishment failure
   * this codebase keeps re-learning, and the first symptom of a protocol
   * dialect mismatch when the MCP ecosystem moves again. The caller that can
   * say so to the user is the runtime; this only answers.
   */
  health(sessionId: string): BridgeHealth {
    const registration = this.#sessions.get(sessionId);
    if (!registration) return { registered: false, initialized: false, listed: false };
    return {
      registered: true,
      initialized: registration.initialized,
      listed: registration.listed,
      ...(registration.client === undefined ? {} : { client: registration.client }),
    };
  }

  #installHandlers(sessionId: string, registration: Registration): void {
    registration.mcp.setRequestHandler(ListToolsRequestSchema, async (): Promise<{ tools: Tool[] }> => {
      registration.listed = true;
      return this.#listTools(registration);
    });
    registration.mcp.setRequestHandler(CallToolRequestSchema, (request, extra) =>
      this.#callTool(sessionId, registration, request.params, extra.signal),
    );
  }

  #listTools(registration: Registration): { tools: Tool[] } {
    return {
      tools: registration.tools.map((tool) => ({
        name: mcpToolName(tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema as Tool['inputSchema'],
      })),
    };
  }

  async #callTool(
    sessionId: string,
    registration: Registration,
    params: { name: string; arguments?: unknown },
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const original = registration.names.get(params.name);
    if (!original) {
      return { content: [{ type: 'text', text: `unknown tool ${params.name}` }], isError: true };
    }
    const startedAt = Date.now();
    this.#log.info('MCP tool call started', { sessionId, data: { tool: original } });
    try {
      const result = await registration.invoke(
        original,
        (params.arguments ?? {}) as Record<string, unknown>,
        signal,
      );
      this.#log.info('MCP tool call completed', {
        sessionId,
        data: { tool: original, durationMs: Date.now() - startedAt },
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
        structuredContent: result && typeof result === 'object' && !Array.isArray(result)
          ? result as Record<string, unknown>
          : undefined,
        isError: false,
      };
    } catch (err) {
      const error = toErr(err);
      this.#log.warn(signal.aborted ? 'MCP tool call cancelled' : 'MCP tool call failed', {
        sessionId,
        err,
        data: { tool: original, durationMs: Date.now() - startedAt },
      });
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  }
}
