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
      { capabilities: { tools: {} } },
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
    };
    this.#installHandlers(sessionId, registration);
    registration.ready = mcp.connect(transport);
    this.#sessions.set(sessionId, registration);
    return { url: `http://127.0.0.1:${this.#port}/mcp/${sessionId}`, token };
  }

  async unregister(sessionId: string): Promise<void> {
    const registration = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    if (!registration) return;
    await registration.ready;
    await registration.mcp.close();
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = /^\/mcp\/([^/?]+)/.exec(req.url ?? '')?.[1];
    const registration = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (!registration) return void res.writeHead(404).end('no such session');
    if (req.headers.authorization !== `Bearer ${registration.token}`) {
      return void res.writeHead(401).end('bad token');
    }
    if (req.method !== 'POST') return void res.writeHead(405).end('post only');

    await registration.ready;
    await registration.transport.handleRequest(req, res);
  }

  #installHandlers(sessionId: string, registration: Registration): void {
    registration.mcp.setRequestHandler(ListToolsRequestSchema, async (): Promise<{ tools: Tool[] }> => ({
      tools: registration.tools.map((tool) => ({
        name: mcpToolName(tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema as Tool['inputSchema'],
      })),
    }));
    registration.mcp.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      const original = registration.names.get(request.params.name);
      if (!original) {
        return { content: [{ type: 'text', text: `unknown tool ${request.params.name}` }], isError: true };
      }
      try {
        const result = await registration.invoke(
          original,
          (request.params.arguments ?? {}) as Record<string, unknown>,
          extra.signal,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
          structuredContent: result && typeof result === 'object' && !Array.isArray(result)
            ? result as Record<string, unknown>
            : undefined,
          isError: false,
        };
      } catch (err) {
        const error = toErr(err);
        this.#log.warn('site tool call failed through MCP', { sessionId, err, data: { tool: original } });
        return { content: [{ type: 'text', text: error.message }], isError: true };
      }
    });
  }
}
