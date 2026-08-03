import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createLogger, toErr, type Logger, type LogSink, type ToolDefinition } from '@agentport/protocol';

/**
 * Serves a session's *site* tools to the agent runtime as an MCP server.
 *
 * This is the mechanical heart of "temporary capability injection": the tools
 * Inkwell lends live here for exactly as long as the session does, bound to a
 * URL + bearer token nobody else holds. When the session closes the endpoint
 * disappears and the runtime's tool list shrinks back to whatever the user's
 * own agent already had.
 *
 * Streamable HTTP with a plain JSON response per request — no SSE needed,
 * since every call is request/response.
 */

const MCP_PROTOCOL_VERSION = '2025-06-18';

/** MCP tool names are stricter than ours; `a.b.c` becomes `a_b_c`. */
export function mcpToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

export type ToolInvoker = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface McpBridgeOptions {
  sink?: LogSink;
}

interface Registration {
  token: string;
  tools: ToolDefinition[];
  invoke: ToolInvoker;
  /** mcp-safe name -> original name */
  names: Map<string, string>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export class McpBridge {
  #server: Server | undefined;
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
        if (!res.headersSent) res.writeHead(500);
        if (!res.writableEnded) res.end('internal error');
      });
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Loopback only. Nothing outside this machine may reach the site's tools.
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    this.#port = typeof address === 'object' && address ? address.port : 0;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  register(sessionId: string, tools: ToolDefinition[], invoke: ToolInvoker): { url: string; token: string } {
    const token = randomBytes(24).toString('hex');
    const names = new Map(tools.map((tool) => [mcpToolName(tool.name), tool.name]));
    this.#sessions.set(sessionId, { token, tools, invoke, names });
    return { url: `http://127.0.0.1:${this.#port}/mcp/${sessionId}`, token };
  }

  unregister(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  // -------------------------------------------------------------------------

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = /^\/mcp\/([^/?]+)/.exec(req.url ?? '')?.[1];
    const registration = sessionId ? this.#sessions.get(sessionId) : undefined;

    if (!registration) return void res.writeHead(404).end('no such session');
    if (req.headers.authorization !== `Bearer ${registration.token}`) {
      return void res.writeHead(401).end('bad token');
    }
    if (req.method !== 'POST') return void res.writeHead(405).end('post only');

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    let message: JsonRpcRequest;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (err) {
      this.#log.warn('rejected malformed MCP JSON', { err, sessionId });
      return void res.writeHead(400).end('bad json');
    }

    // Notifications carry no id and expect no body.
    if (message.id === undefined) return void res.writeHead(202).end();

    const reply = (result: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };
    const fail = (code: number, msg: string) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code, message: msg } }));
    };

    switch (message.method) {
      case 'initialize':
        return reply({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agentport-surface', version: '0.0.1' },
        });

      case 'ping':
        return reply({});

      case 'tools/list':
        return reply({
          tools: registration.tools.map((tool) => ({
            name: mcpToolName(tool.name),
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });

      case 'tools/call': {
        const called = String(message.params?.name ?? '');
        const original = registration.names.get(called);
        if (!original) return fail(-32602, `unknown tool ${called}`);
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const result = await registration.invoke(original, args);
          return reply({
            content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
            isError: false,
          });
        } catch (err) {
          // Reported as a tool error, not a protocol error, so the model can
          // see the refusal and react to it.
          this.#log.warn('site tool call failed through MCP', {
            sessionId,
            err,
            data: { tool: original },
          });
          return reply({
            content: [{ type: 'text', text: toErr(err).message }],
            isError: true,
          });
        }
      }

      default:
        return fail(-32601, `method not found: ${message.method}`);
    }
  }
}
