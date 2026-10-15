# @closedmcp/sdk

A small TypeScript/Node wrapper for MCP servers using Log in with ClosedMCP. It verifies a signed pass on every MCP request and serves protected-resource metadata. It uses the official `@modelcontextprotocol/sdk` HTTP transport. No database or web framework is required.

Install with `npm install @closedmcp/sdk @modelcontextprotocol/sdk`.

## Add to an existing official MCP server

If you already have a function that creates and registers tools on a `McpServer`, pass it to `serveWithClosedMcp`:

```ts
serveWithClosedMcp(createMcpServer, { resource: process.env.MCP_URL!, allowedDomains: process.env.ALLOWED_DOMAINS!.split(",") });
```

The factory must return a fresh server for each stateless HTTP request. In a tool, call `closedMcpPerson().email` or `.org`.

## Hello server

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closedMcpPerson, serveWithClosedMcp } from "@closedmcp/sdk";

serveWithClosedMcp(() => {
  const mcp = new McpServer({ name: "hello", version: "1.0.0" });
  mcp.registerTool("hello", { inputSchema: {} }, async () => ({
    content: [{ type: "text", text: `Hello ${closedMcpPerson().email}` }],
  }));
  return mcp;
}, {
  resource: "https://example.com/mcp",
  allowedDomains: ["example.com"],
});
```

`closedMcpPerson()` returns `{ id, email, company, org, aiApp? }` for the current verified call. `company` is the verified company domain. `aiApp` comes from a client-supplied claim and is for display only. The function throws outside a verified MCP request.

Set `resource` to the exact public MCP URL registered in ClosedMCP. The default Node server port is 8787; pass `port` and optionally `host` to change it. The returned `http.Server` can be closed normally. `allowedDomains` must contain at least one company domain; a valid identity alone does not grant customer access.

The [template](template/server.mjs) is a runnable JavaScript version of this server. Run `npm install` in the template folder, set `MCP_URL` and `ALLOWED_DOMAINS`, and run `npm start`. The template also accepts `PORT`. `CLOSEDMCP_ORIGIN` and `CLOSEDMCP_JWKS_URL` exist for local integration tests.

The wrapper handles MCP POST requests concurrently. The server factory creates a fresh `McpServer` for each request, as required by the official stateless transport. MCP GET and DELETE return `405`.

The wrapper serves `/.well-known/oauth-protected-resource/mcp` for a `/mcp` resource path (and the generic metadata path). Unauthenticated MCP requests receive `401` and `WWW-Authenticate: Bearer resource_metadata="<metadata URL>"`. The verifier checks EdDSA signature using the issuer's JWKS, issuer, exact audience, expiry, five-minute maximum lifetime, required identity claims, and company domain. By default it accepts `https://closedmcp.com` and the legacy `https://closedmcp.canpai.io` issuer, using each issuer's JWKS. Setting `issuer` accepts only that issuer. Keys are cached by `jose`; unknown key IDs can trigger a refresh at most once per 30 seconds, with a 5-second fetch timeout.

## FastMCP

Install with `npm install @closedmcp/sdk fastmcp`. In an HTTP tool, pass its context to `closedMcpPerson`:

```ts
import { FastMCP } from "fastmcp";
import { closedMcpFastMcp, closedMcpPerson } from "@closedmcp/sdk/fastmcp";

const server = new FastMCP({ name: "hello", version: "1.0.0",
  ...closedMcpFastMcp({ resource: "https://example.com/mcp", allowedDomains: ["example.com"] }) });
server.addTool({ name: "hello", description: "Say hello",
  execute: async (_args, context) => `Hello ${closedMcpPerson(context).email}` });
await server.start({ transportType: "httpStream", httpStream: { port: 8787, stateless: true } });
```

FastMCP serves protected-resource metadata through its OAuth support. Set the HTTP endpoint to the path in `resource` if it differs from `/mcp`.

## Vercel MCP adapter

Install `mcp-handler` alongside `@closedmcp/sdk`. In `app/api/mcp/route.ts`:

```ts
import { createMcpHandler } from "mcp-handler";
import { withClosedMcpAuth, closedMcpPerson } from "@closedmcp/sdk/vercel";

const options = { resource: "https://example.com/api/mcp", allowedDomains: ["example.com"] };
const handler = withClosedMcpAuth(createMcpHandler((server) => {
  server.registerTool("hello", { inputSchema: {} }, async (_args, context) => ({
    content: [{ type: "text", text: `Hello ${closedMcpPerson(context).email}` }],
  }));
}, { serverInfo: { name: "hello", version: "1.0.0" } }), options);
export { handler as GET, handler as POST, handler as DELETE };
```

In `app/.well-known/oauth-protected-resource/api/mcp/route.ts`, export the metadata route:

```ts
import { closedMcpResourceMetadata } from "@closedmcp/sdk/vercel";
export const GET = closedMcpResourceMetadata({
  resource: "https://example.com/api/mcp", allowedDomains: ["example.com"],
});
```

Use the same options for both routes. Both adapters verify every pass with `createClosedMcpVerifier`. Their tool contexts carry the verified person; `closedMcpPerson(context)` throws when no verified person is present.

## Hosted on ClosedMCP (Serverless MCPs)

An app hosted on ClosedMCP does not use sign-in: ClosedMCP checks the caller and strips `Authorization` (so `serveWithClosedMcp` would reject every call). Use `@closedmcp/sdk/hosted` instead. Serve `/mcp` on `0.0.0.0:8080` (`HOSTED_PATH`, `HOSTED_PORT`).

```ts
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { caller, events, openChannel, HOSTED_PORT } from "@closedmcp/sdk/hosted";

createServer(async (req, res) => {
  const s = new McpServer({ name: "chat", version: "1.0.0" });
  s.registerTool("watch", { inputSchema: { room: z.string() } }, async ({ room }) => ({
    content: [{ type: "text", text: `Watching #${room}.` }], _meta: openChannel({ topic: `room:${room}`, name: `#${room}` }) }));
  s.registerTool("post", { inputSchema: { room: z.string(), text: z.string() } }, async ({ room, text }, extra) => ({
    content: [{ type: "text", text: "Sent." }], _meta: events([{ topic: `room:${room}`, data: { from: caller(extra).email, text } }]) }));
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await s.connect(t); await t.handleRequest(req, res);
}).listen(HOSTED_PORT, "0.0.0.0");
```

- `caller(source)` returns `{ id, email, org, client }` from the `X-ClosedMCP-*` headers and throws when they are missing. `source` is the official SDK's `extra`, a FastMCP `context` (spread `...hostedFastMcp()` into `new FastMCP({...})`), a request, or a headers object. `tryCaller` returns `undefined` instead of throwing.
- `openChannel({ topic, name?, ttl? })` and `events([{ topic, data }])` build the `_meta` keys and throw on anything ClosedMCP would drop or change (`LIMITS`: topic at most 200 characters, name 80, ttl whole seconds from 30 to 7 days, at most 20 events, `data` at most 8 KB as JSON). Combine them with `{ ...openChannel(...), ...events(...) }`.
- `databaseUrl()` returns `DATABASE_URL` (throws if no database is enabled); `liveDatabaseUrl()` returns the read-only live URL in `closedmcp_run` sandboxes.

See the [ClosedMCP documentation](https://closedmcp.com/docs).
