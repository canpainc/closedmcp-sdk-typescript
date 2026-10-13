import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FastMCP } from "fastmcp";
import { createMcpHandler } from "mcp-handler";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { closedMcpPerson, createClosedMcpVerifier, serveWithClosedMcp } from "../dist/index.js";
import { closedMcpFastMcp } from "../dist/fastmcp.js";
import { closedMcpResourceMetadata, withClosedMcpAuth } from "../dist/vercel.js";

const emailOne = ["user1", "example.com"].join("@");
const emailTwo = ["user2", "example.com"].join("@");
const slowEmail = ["slow", "example.com"].join("@");
const fastEmail = ["fast", "example.com"].join("@");
const otherEmail = ["user1", "other.example"].join("@");
const resource = "http://127.0.0.1:8798/mcp";
const issuer = "https://issuer.example";
let keyPair;
let jwksServer;
let jwksUrl;
let jwksRequests = 0;
let template;

async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}

async function pass(changes = {}, key = keyPair.privateKey, kid = "test-key") {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: issuer, aud: resource, sub: "person-123", email: emailOne,
    domain: "example.com", org: "acme", client: "Test app", iat: now,
    exp: now + 300, jti: "pass-123", ...changes,
  };
  return new SignJWT({ email: claims.email, domain: claims.domain, org: claims.org, client: claims.client, jti: claims.jti })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuer(claims.iss).setAudience(claims.aud).setSubject(claims.sub)
    .setIssuedAt(claims.iat).setExpirationTime(claims.exp).sign(key);
}

before(async () => {
  keyPair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const publicKey = { ...await exportJWK(keyPair.publicKey), kid: "test-key", alg: "EdDSA", use: "sig" };
  jwksServer = createServer((_req, res) => {
    jwksRequests++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [publicKey] }));
  });
  jwksServer.listen(0, "127.0.0.1");
  await once(jwksServer, "listening");
  jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/.well-known/jwks.json`;
});

after(async () => {
  if (template && template.exitCode === null) {
    const exited = once(template, "exit");
    template.kill();
    await exited;
  }
  await new Promise((done) => jwksServer.close(done));
});

function verifier(overrides = {}) {
  return createClosedMcpVerifier({ resource, allowedDomains: ["example.com"], issuer, jwksUrl, ...overrides });
}

test("accepts a correctly signed pass and exposes the person", async () => {
  assert.deepEqual(await verifier()(`Bearer ${await pass()}`), {
    id: "person-123", email: emailOne, company: "example.com", org: "acme", aiApp: "Test app",
  });
});

test("defaults to the current and legacy issuers, but rejects other issuers", async () => {
  const verify = createClosedMcpVerifier({ resource, allowedDomains: ["example.com"], jwksUrl });
  for (const iss of ["https://closedmcp.com", "https://closedmcp.canpai.io"]) {
    assert.equal((await verify(`Bearer ${await pass({ iss })}`)).id, "person-123");
  }
  await assert.rejects(verify(`Bearer ${await pass({ iss: issuer })}`));
  await assert.rejects(verifier()(`Bearer ${await pass({ iss: "https://closedmcp.com" })}`));
});

test("unknown key IDs respect the JWKS refresh cooldown", async () => {
  const verify = verifier();
  await verify(`Bearer ${await pass()}`);
  const fetched = jwksRequests;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(verify(`Bearer ${await pass({}, keyPair.privateKey, "unknown-key")}`));
  }
  assert.equal(jwksRequests, fetched);
});

test("refuses missing, wrong-audience, expired, overlong, disallowed-company and bad-signature passes", async () => {
  const verify = verifier();
  const now = Math.floor(Date.now() / 1000);
  const otherKey = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  for (const [name, token] of [
    ["missing", undefined],
    ["wrong-audience", await pass({ aud: "https://other.example/mcp" })],
    ["expired", await pass({ iat: now - 601, exp: now - 301 })],
    ["overlong", await pass({ iat: now, exp: now + 301 })],
    ["disallowed-company", await pass({ domain: "other.example", email: otherEmail })],
    ["bad-signature", await pass({}, otherKey.privateKey)],
  ]) {
    await assert.rejects(() => verify(token && `Bearer ${token}`), name);
  }
  assert.throws(() => verifier({ allowedDomains: [] }), /allowedDomains/);
});

test("template serves metadata, rejects unauthenticated requests and answers a real MCP call", async () => {
  const templatePath = resolve(dirname(fileURLToPath(import.meta.url)), "../template/server.mjs");
  const listenPort = await port();
  const base = `http://127.0.0.1:${listenPort}`;
  template = spawn(process.execPath, [templatePath], {
    env: { ...process.env, MCP_URL: resource, ALLOWED_DOMAINS: "example.com", PORT: String(listenPort), CLOSEDMCP_ORIGIN: issuer, CLOSEDMCP_JWKS_URL: jwksUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  template.stderr.on("data", (chunk) => { errors += chunk; });
  template.stdout.on("data", (chunk) => { errors += chunk; });
  let metadata;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
      if (response.ok) { metadata = await response.json(); break; }
    } catch { /* waiting for the child to listen */ }
    if (template.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.ok(metadata, errors);
  assert.deepEqual(metadata, {
    resource, authorization_servers: [issuer], bearer_methods_supported: ["header"],
  });
  const unauth = await fetch(`${base}/mcp`, { method: "POST" });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers.get("www-authenticate"), `Bearer resource_metadata="${new URL(resource).origin}/.well-known/oauth-protected-resource/mcp"`);

  const authorization = `Bearer ${await pass()}`;
  async function call(method, params, id) {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, `${body} ${errors}`);
    const data = body.startsWith("event:") ? body.split("\n").find((line) => line.startsWith("data: ")).slice(6) : body;
    return JSON.parse(data);
  }
  const initialized = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }, 1);
  assert.equal(initialized.result.serverInfo.name, "hello");
  const listed = await call("tools/list", {}, 2);
  assert.equal(listed.result.tools[0].name, "hello");
  const answer = await call("tools/call", { name: "hello", arguments: {} }, 3);
  assert.equal(answer.result.content[0].text, `Hello ${emailOne}`);
});

test("concurrent calls finish independently and keep each person's identity", async () => {
  let enteredSlow;
  const slowStarted = new Promise((resolve) => { enteredSlow = resolve; });
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  const server = serveWithClosedMcp(() => {
    const mcp = new McpServer({ name: "concurrent", version: "1.0.0" });
    mcp.registerTool("slow", { inputSchema: {} }, async () => {
      enteredSlow();
      await slowGate;
      return { content: [{ type: "text", text: closedMcpPerson().email }] };
    });
    mcp.registerTool("fast", { inputSchema: {} }, async () => ({
      content: [{ type: "text", text: closedMcpPerson().email }],
    }));
    return mcp;
  }, { resource, allowedDomains: ["example.com"], issuer, jwksUrl, port: 0, host: "127.0.0.1" });
  let timer;
  try {
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    async function call(name, email, id) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await pass({ email, sub: String(id) })}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } }),
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      const data = body.startsWith("event:") ? body.split("\n").find((line) => line.startsWith("data: ")).slice(6) : body;
      return JSON.parse(data).result.content[0].text;
    }
    const slow = call("slow", slowEmail, 1);
    await slowStarted;
    const fast = call("fast", fastEmail, 2);
    const fastResult = await Promise.race([
      fast,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("fast call waited for slow call")), 2000); }),
    ]);
    assert.equal(fastResult, fastEmail);
    releaseSlow();
    assert.equal(await slow, slowEmail);
  } finally {
    clearTimeout(timer);
    releaseSlow();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("FastMCP accepts a signed pass in a real tool call and refuses missing credentials", async () => {
  const listenPort = await port();
  const server = new FastMCP({
    name: "hello", version: "1.0.0",
    ...closedMcpFastMcp({ resource, allowedDomains: ["example.com"], issuer, jwksUrl }),
  });
  server.addTool({
    name: "hello", description: "Say hello",
    execute: async (_args, context) => `Hello ${closedMcpPerson(context).email}`,
  });
  await server.start({ transportType: "httpStream", httpStream: { port: listenPort, host: "127.0.0.1", stateless: true } });
  try {
    const url = `http://127.0.0.1:${listenPort}/mcp`;
    const unauth = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }),
    });
    assert.equal(unauth.status, 401);
    const denied = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${await pass({ domain: "other.example" })}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }),
    });
    assert.equal(denied.status, 401);
    const discovery = await fetch(`http://127.0.0.1:${listenPort}/.well-known/oauth-protected-resource/mcp`);
    assert.equal((await discovery.json()).resource, resource);
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${await pass()}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hello", arguments: {} } }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const data = body.startsWith("event:") ? body.split("\n").find((line) => line.startsWith("data: ")).slice(6) : body;
    assert.equal(JSON.parse(data).result.content[0].text, `Hello ${emailOne}`);
  } finally {
    await server.stop();
  }
});

test("Vercel handler accepts a signed pass and refuses missing credentials", async () => {
  const options = { resource, allowedDomains: ["example.com"], issuer, jwksUrl };
  const handler = withClosedMcpAuth(createMcpHandler((mcp) => {
    mcp.registerTool("hello", { inputSchema: {} }, async (_args, context) => ({
      content: [{ type: "text", text: `Hello ${closedMcpPerson(context).email}` }],
    }));
  }, { serverInfo: { name: "hello", version: "1.0.0" } }), options);
  const metadata = await closedMcpResourceMetadata(options)(new Request(`${new URL(resource).origin}/.well-known/oauth-protected-resource/mcp`));
  assert.equal((await metadata.json()).resource, resource);
  const unauth = await handler(new Request(resource, { method: "POST" }));
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get("www-authenticate"), /\.well-known\/oauth-protected-resource\/mcp/);
  const denied = await handler(new Request(resource, {
    method: "POST", headers: { authorization: `Bearer ${await pass({ domain: "other.example" })}` },
  }));
  assert.equal(denied.status, 401);
  const response = await handler(new Request(resource, {
    method: "POST",
    headers: { authorization: `Bearer ${await pass()}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hello", arguments: {} } }),
  }));
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const data = body.startsWith("event:") ? body.split("\n").find((line) => line.startsWith("data: ")).slice(6) : body;
  assert.equal(JSON.parse(data).result.content[0].text, `Hello ${emailOne}`);
});
