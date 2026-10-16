// Helpers for Serverless MCPs hosted on ClosedMCP. No network, no sign-in:
// ClosedMCP has already checked the caller and passes them in headers.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** Hosted apps serve MCP here. */
export const HOSTED_PORT = 8080;
export const HOSTED_PATH = "/mcp";

/** Request headers the ClosedMCP runner sets on every call (lowercase). */
export const HEADERS = {
  id: "x-closedmcp-user",
  email: "x-closedmcp-email",
  org: "x-closedmcp-org",
  client: "x-closedmcp-client",
} as const;

/** Limits ClosedMCP applies to channel and event `_meta`. */
export const LIMITS = {
  topicMaxChars: 200,
  nameMaxChars: 80,
  ttlMinSeconds: 30,
  ttlMaxSeconds: 7 * 86_400,
  ttlDefaultSeconds: 86_400,
  eventsPerResult: 20,
  eventDataMaxBytes: 8 << 10,
  eventsPerChannelPerHour: 60,
} as const;

export const CHANNEL_KEY = "closedmcp/channel";
export const EVENTS_KEY = "closedmcp/events";

/** Who is calling. All four are always set by ClosedMCP. */
export interface Caller {
  /** Person ID, stable. */
  id: string;
  email: string;
  /** Company org ID. */
  org: string;
  /** AI app, for display only. */
  client: string;
}

type HeaderBag = Record<string, string | string[] | undefined> | { get(name: string): string | null };

/**
 * Anything that carries the request headers:
 * - official MCP SDK tool `extra` (`extra.requestInfo.headers`),
 * - FastMCP tool `context` when the server uses `hostedFastMcp()`,
 * - an `IncomingMessage` / `Request`, or a plain headers object or `Headers`.
 */
export type CallerSource =
  | HeaderBag
  | { requestInfo?: { headers?: HeaderBag } }
  | { session?: unknown }
  | { headers?: HeaderBag };

export type HostedFastMcpSession = { closedMcpCaller?: Caller };

function header(bag: HeaderBag, name: string): string | undefined {
  const value = typeof bag.get === "function"
    ? (bag as { get(name: string): string | null }).get(name)
    : (bag as Record<string, string | string[] | undefined>)[name];
  const one = Array.isArray(value) ? value[0] : value;
  return one || undefined;
}

/** The caller, or `undefined` when the request did not come through ClosedMCP. */
export function tryCaller(source: CallerSource | undefined): Caller | undefined {
  if (!source || typeof source !== "object") return undefined;
  const session = (source as { session?: HostedFastMcpSession }).session;
  if (session?.closedMcpCaller) return session.closedMcpCaller;
  const bag = (source as { requestInfo?: { headers?: HeaderBag } }).requestInfo?.headers
    ?? (source as { headers?: HeaderBag }).headers
    ?? (source as HeaderBag);
  const [id, email, org, client] = [HEADERS.id, HEADERS.email, HEADERS.org, HEADERS.client].map((h) => header(bag, h));
  return id && email && org && client ? { id, email, org, client } : undefined;
}

/** The caller; throws when the X-ClosedMCP-* headers are missing (not running on ClosedMCP). */
export function caller(source: CallerSource | undefined): Caller {
  const found = tryCaller(source);
  if (!found) {
    throw new Error("No ClosedMCP caller: X-ClosedMCP-User/Email/Org/Client headers are missing (is this running on ClosedMCP?)");
  }
  return found;
}

/** Spread into `new FastMCP({...})`; then `caller(context)` works in tools. Never rejects a request. */
export function hostedFastMcp() {
  return {
    authenticate: async (request: { headers: HeaderBag }): Promise<HostedFastMcpSession> => ({
      closedMcpCaller: tryCaller(request.headers),
    }),
  };
}

function checkTopic(topic: unknown, where: string): string {
  if (typeof topic !== "string" || topic.length === 0) throw new Error(`${where}: topic must be a non-empty string`);
  if ([...topic].length > LIMITS.topicMaxChars) throw new Error(`${where}: topic is over ${LIMITS.topicMaxChars} characters`);
  return topic;
}

export interface ChannelRequest {
  /** Events with this topic reach the channel. Put the scope in it, e.g. `room:<id>`. */
  topic: string;
  /** Shown to the agent. */
  name?: string;
  /** Whole seconds, 30 to 7 days; ClosedMCP defaults to 1 day. */
  ttl?: number;
}

/** `_meta` that opens an event channel the caller can wait on. */
export function openChannel(request: ChannelRequest): { [CHANNEL_KEY]: ChannelRequest } {
  const channel: ChannelRequest = { topic: checkTopic(request.topic, "openChannel") };
  if (request.name !== undefined) {
    if (typeof request.name !== "string") throw new Error("openChannel: name must be a string");
    if ([...request.name].length > LIMITS.nameMaxChars) throw new Error(`openChannel: name is over ${LIMITS.nameMaxChars} characters`);
    channel.name = request.name;
  }
  if (request.ttl !== undefined) {
    const { ttlMinSeconds: min, ttlMaxSeconds: max } = LIMITS;
    if (!Number.isInteger(request.ttl) || request.ttl < min || request.ttl > max) {
      throw new Error(`openChannel: ttl must be whole seconds from ${min} to ${max}`);
    }
    channel.ttl = request.ttl;
  }
  return { [CHANNEL_KEY]: channel };
}

export interface HostedEvent {
  topic: string;
  /** Any JSON value; at most 8 KB serialized. */
  data: unknown;
}

/** `_meta` that delivers each event to the app's open channels with that topic. */
export function events(list: HostedEvent[]): { [EVENTS_KEY]: HostedEvent[] } {
  if (!Array.isArray(list)) throw new Error("events: give an array of {topic, data}");
  if (list.length > LIMITS.eventsPerResult) throw new Error(`events: at most ${LIMITS.eventsPerResult} per result`);
  return {
    [EVENTS_KEY]: list.map((event, i) => {
      const topic = checkTopic(event?.topic, `events[${i}]`);
      const json = JSON.stringify(event.data);
      if (json === undefined) throw new Error(`events[${i}]: data must be a JSON value`);
      if (Buffer.byteLength(json) > LIMITS.eventDataMaxBytes) {
        throw new Error(`events[${i}]: data is over ${LIMITS.eventDataMaxBytes} bytes as JSON`);
      }
      return { topic, data: JSON.parse(json) };
    }),
  };
}

/** What `serve` needs from an MCP server: the official SDK's `McpServer` or low-level `Server`. */
export interface ConnectableMcpServer {
  connect(transport: StreamableHTTPServerTransport): Promise<void>;
  close(): Promise<void>;
}

export interface ServeOptions {
  /** Defaults to 8080, where ClosedMCP calls a hosted app. */
  port?: number;
  /** Defaults to 0.0.0.0; ClosedMCP cannot reach an app listening on 127.0.0.1. */
  host?: string;
}

/**
 * Serve MCP Streamable HTTP at `/mcp` on `0.0.0.0:8080`, stateless, as ClosedMCP expects.
 * `createMcpServer` builds a fresh server for each request. Use it instead of a
 * `StdioServerTransport`, which never goes live on ClosedMCP.
 */
export function serve(createMcpServer: () => ConnectableMcpServer, options: ServeOptions = {}): Server {
  if (typeof createMcpServer !== "function") {
    throw new TypeError("serve: give a function that returns a new McpServer, e.g. serve(() => build())");
  }
  const send = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== HOSTED_PATH) {
      send(res, 404, "not found");
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, "method not allowed");
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      const mcp = createMcpServer();
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } finally {
        await mcp.close();
      }
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) send(res, 500, "internal server error");
      else res.destroy();
    }
  });
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? HOSTED_PORT;
  server.listen(port, host, () => console.error(`MCP server listening on http://${host}:${port}${HOSTED_PATH}`));
  return server;
}

/** The app's PostgreSQL URL (live when published, dev in runs). Throws if no database is enabled. */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set: enable a database with closedmcp_database_enable");
  return url;
}

/** Read-only URL for the live database; set only in `closedmcp_run` sandboxes. */
export function liveDatabaseUrl(): string | undefined {
  return process.env.LIVE_DATABASE_URL || undefined;
}
