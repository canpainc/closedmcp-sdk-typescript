import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FastMCP } from "fastmcp";
import {
  CHANNEL_KEY, EVENTS_KEY, HEADERS, LIMITS, caller, databaseUrl, events, hostedFastMcp,
  liveDatabaseUrl, openChannel, tryCaller,
} from "../dist/hosted.js";

const email = ["bob", "acme.dev"].join("@");
const fakeHeaders = {
  "X-ClosedMCP-User": "u-123",
  "X-ClosedMCP-Email": email,
  "X-ClosedMCP-Org": "acme",
  "X-ClosedMCP-Client": "Claude",
};
const expected = { id: "u-123", email, org: "acme", client: "Claude" };
const lower = Object.fromEntries(Object.entries(fakeHeaders).map(([k, v]) => [k.toLowerCase(), v]));

async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}

async function callTool(url, name, args, headers = fakeHeaders) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

test("caller reads the runner headers from every supported source", () => {
  assert.deepEqual(caller(lower), expected);
  assert.deepEqual(caller(new Headers(fakeHeaders)), expected);
  assert.deepEqual(caller({ requestInfo: { headers: lower } }), expected);
  assert.deepEqual(caller({ headers: lower }), expected);
  assert.deepEqual(caller({ session: { closedMcpCaller: expected } }), expected);
  assert.deepEqual(caller({ ...lower, [HEADERS.id]: ["u-123", "u-9"] }), expected);
});

test("caller throws, and tryCaller returns undefined, without all four headers", () => {
  for (const missing of Object.values(HEADERS)) {
    const headers = { ...lower, [missing]: "" };
    assert.equal(tryCaller(headers), undefined, missing);
    assert.throws(() => caller(headers), /X-ClosedMCP/);
  }
  assert.equal(tryCaller(undefined), undefined);
  assert.equal(tryCaller({ session: undefined }), undefined);
  assert.throws(() => caller({ requestInfo: { headers: {} } }), /running on ClosedMCP/);
});

test("openChannel builds the channel _meta and enforces ClosedMCP limits", () => {
  assert.deepEqual(openChannel({ topic: "room:general" }), { [CHANNEL_KEY]: { topic: "room:general" } });
  assert.deepEqual(openChannel({ topic: "t", name: "#general", ttl: 600 }), {
    "closedmcp/channel": { topic: "t", name: "#general", ttl: 600 },
  });
  assert.ok(openChannel({ topic: "é".repeat(LIMITS.topicMaxChars) }));
  assert.ok(openChannel({ topic: "t", ttl: 30 }) && openChannel({ topic: "t", ttl: 604_800 }));
  for (const bad of [
    {}, { topic: "" }, { topic: 7 }, { topic: "x".repeat(201) },
    { topic: "t", name: "n".repeat(81) }, { topic: "t", name: 1 },
    { topic: "t", ttl: 29 }, { topic: "t", ttl: 604_801 }, { topic: "t", ttl: 60.5 }, { topic: "t", ttl: "60" },
  ]) {
    assert.throws(() => openChannel(bad), /openChannel/, JSON.stringify(bad));
  }
});

test("events builds the events _meta and enforces ClosedMCP limits", () => {
  const data = { from: email, text: "hi" };
  assert.deepEqual(events([{ topic: "room:general", data }]), { [EVENTS_KEY]: [{ topic: "room:general", data }] });
  assert.deepEqual(events([]), { "closedmcp/events": [] });
  assert.equal(events(Array.from({ length: 20 }, () => ({ topic: "t", data: 1 })))[EVENTS_KEY].length, 20);
  // Exactly 8 KB of JSON passes; one more byte (or a multi-byte char) does not.
  assert.ok(events([{ topic: "t", data: "x".repeat(8192 - 2) }]));
  assert.throws(() => events([{ topic: "t", data: "x".repeat(8192 - 1) }]), /8192 bytes/);
  assert.throws(() => events([{ topic: "t", data: "é".repeat(4096) }]), /8192 bytes/);
  assert.throws(() => events(Array.from({ length: 21 }, () => ({ topic: "t", data: 1 }))), /at most 20/);
  assert.throws(() => events([{ topic: "t", data: undefined }]), /JSON value/);
  assert.throws(() => events([{ topic: "", data: 1 }]), /events\[0\]: topic/);
  assert.throws(() => events([{ data: 1 }]), /topic/);
  assert.throws(() => events({ topic: "t", data: 1 }), /array/);
});

test("database accessors read the runtime env", () => {
  const saved = { ...process.env };
  try {
    delete process.env.DATABASE_URL;
    delete process.env.LIVE_DATABASE_URL;
    assert.throws(() => databaseUrl(), /closedmcp_database_enable/);
    assert.equal(liveDatabaseUrl(), undefined);
    process.env.DATABASE_URL = "postgresql://a@h/db";
    process.env.LIVE_DATABASE_URL = "postgresql://r@h/live";
    assert.equal(databaseUrl(), "postgresql://a@h/db");
    assert.equal(liveDatabaseUrl(), "postgresql://r@h/live");
  } finally {
    process.env = saved;
  }
});

test("official MCP SDK: caller from extra and _meta reach the client", async () => {
  const server = createServer(async (req, res) => {
    const mcp = new McpServer({ name: "chat", version: "1.0.0" });
    mcp.registerTool("post", { inputSchema: { room: z.string(), text: z.string() } }, async ({ room, text }, extra) => {
      const me = caller(extra);
      return {
        content: [{ type: "text", text: `Sent as ${me.email}.` }],
        _meta: { ...openChannel({ topic: `room:${room}` }), ...events([{ topic: `room:${room}`, data: { from: me.id, text } }]) },
      };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const result = await callTool(url, "post", { room: "general", text: "hi" });
    assert.equal(result.content[0].text, `Sent as ${email}.`);
    assert.deepEqual(result._meta, {
      "closedmcp/channel": { topic: "room:general" },
      "closedmcp/events": [{ topic: "room:general", data: { from: "u-123", text: "hi" } }],
    });
    const anonymous = await callTool(url, "post", { room: "general", text: "hi" }, {});
    assert.equal(anonymous.isError, true);
    assert.match(anonymous.content[0].text, /X-ClosedMCP/);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

test("FastMCP: hostedFastMcp() makes caller(context) work", async () => {
  const server = new FastMCP({ name: "chat", version: "1.0.0", ...hostedFastMcp() });
  server.addTool({
    name: "whoami",
    parameters: z.object({}),
    execute: async (_args, context) => ({
      content: [{ type: "text", text: caller(context).email }],
      _meta: events([{ topic: "seen", data: caller(context) }]),
    }),
  });
  const listenPort = await port();
  await server.start({ transportType: "httpStream", httpStream: { port: listenPort, host: "127.0.0.1", stateless: true } });
  try {
    const result = await callTool(`http://127.0.0.1:${listenPort}/mcp`, "whoami", {});
    assert.equal(result.content[0].text, email);
    assert.deepEqual(result._meta, { "closedmcp/events": [{ topic: "seen", data: expected }] });
  } finally {
    await server.stop();
  }
});
