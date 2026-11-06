import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import express from "express";
import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError, InsufficientScopeError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export const CLOSEDMCP = "https://closedmcp.com";
export const REQUIRED_SCOPE = "mcp:tools";
const CLAIMS = "https://closedmcp.com/claims/";

export interface ClosedMcpPerson {
  id: string;
  email: string;
  company: string;
  org: string;
  aiApp?: string;
}

export interface ClosedMcpOptions {
  /** Exact public MCP URL, also used as the JWT audience and metadata resource. */
  resource: string;
  /** Verified company domains served by this MCP. At least one is required. */
  allowedDomains: string[];
  /** For local tests. Defaults to the public ClosedMCP issuer. */
  issuer?: string;
  /** For local tests. Defaults to the issuer's JWKS. */
  jwksUrl?: string;
}

const people = new AsyncLocalStorage<ClosedMcpPerson>();

/** The verified person for the current MCP call. Pass a tool context when using an adapter. */
export function closedMcpPerson(context?: {
  session?: unknown;
  http?: { authInfo?: { extra?: unknown } };
}): ClosedMcpPerson {
  const session = context?.session as { closedMcpPerson?: ClosedMcpPerson } | undefined;
  const extra = context?.http?.authInfo?.extra as { closedMcpPerson?: ClosedMcpPerson } | undefined;
  const person = session?.closedMcpPerson ?? extra?.closedMcpPerson ?? people.getStore();
  if (!person) throw new Error("No verified ClosedMCP person in this request");
  return person;
}

/** An official MCP SDK token verifier; person helpers retain the same shape. */
export function createClosedMcpTokenVerifier(options: ClosedMcpOptions) {
  const { resource } = options;
  const url = new URL(resource);
  if (!resource || !["http:", "https:"].includes(url.protocol) || url.hash || url.search || url.username || url.password) {
    throw new Error("resource must be an absolute HTTP(S) MCP URL without query or fragment");
  }
  const allowed = new Set(options.allowedDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0) throw new Error("allowedDomains must name at least one company");
  const issuer = options.issuer ?? CLOSEDMCP;
  const keys = createRemoteJWKSet(new URL(options.jwksUrl ?? `${issuer}/.well-known/jwks.json`),
    { cooldownDuration: 30_000, timeoutDuration: 5_000 });
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const { payload } = await jwtVerify(token, keys, {
          algorithms: ["EdDSA"], issuer, audience: resource, typ: "at+jwt", maxTokenAge: "5m",
          requiredClaims: ["iss", "aud", "sub", "email", `${CLAIMS}domain`, `${CLAIMS}org`, "iat", "exp", "jti", "client_id", "scope"],
        });
        if (payload.aud !== resource) throw new Error("Wrong MCP audience");
        if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.exp - payload.iat > 300 || payload.exp <= payload.iat) {
          throw new Error("Access token lifetime is invalid");
        }
        const domain = payload[`${CLAIMS}domain`], org = payload[`${CLAIMS}org`], client = payload[`${CLAIMS}client`];
        for (const value of [payload.sub, payload.email, domain, org, payload.jti, payload.client_id]) {
          if (typeof value !== "string" || !value) throw new Error("Access token claims are invalid");
        }
        if (typeof payload.scope !== "string" || (client !== undefined && typeof client !== "string")) throw new Error("Access token claims are invalid");
        if (!allowed.has((domain as string).toLowerCase())) throw new Error("Company is not allowed");
        const person: ClosedMcpPerson = { id: payload.sub!, email: payload.email as string, company: domain as string, org: org as string, aiApp: client as string | undefined };
        return { token, clientId: payload.client_id as string, scopes: payload.scope.split(/\s+/), expiresAt: payload.exp,
          resource: new URL(resource), extra: { closedMcpPerson: person } };
      } catch {
        throw new InvalidTokenError("Invalid access token");
      }
    },
  };
}

export function createClosedMcpVerifier(options: ClosedMcpOptions) {
  const verifier = createClosedMcpTokenVerifier(options);
  return async (authorization: string | undefined): Promise<ClosedMcpPerson> => {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
    if (!token) throw new InvalidTokenError("No access token");
    const auth = await verifier.verifyAccessToken(token);
    if (!auth.scopes.includes(REQUIRED_SCOPE)) throw new InsufficientScopeError("Insufficient scope");
    return auth.extra!.closedMcpPerson as ClosedMcpPerson;
  };
}

export interface ServeOptions extends ClosedMcpOptions {
  /** Port used by the built-in Node HTTP server. Defaults to 8787. */
  port?: number;
  host?: string;
}

/** Serve a fresh McpServer with the official SDK's bearer checks on every request. */
export function serveWithClosedMcp(createMcpServer: () => McpServer, options: ServeOptions): Server {
  const verifier = createClosedMcpTokenVerifier(options);
  const resourceUrl = new URL(options.resource);
  const mcpPath = resourceUrl.pathname;
  const metadataPath = `/.well-known/oauth-protected-resource${mcpPath === "/" ? "" : mcpPath}`;
  const metadataUrl = `${resourceUrl.origin}${metadataPath}`;
  const app = express();
  app.use(hostHeaderValidation([resourceUrl.hostname, "localhost", "127.0.0.1", "[::1]"]));
  app.use(express.json({ limit: "4mb" }));
  app.get([metadataPath, "/.well-known/oauth-protected-resource"], (_req, res) => {
    res.json({ resource: options.resource, authorization_servers: [options.issuer ?? CLOSEDMCP],
      bearer_methods_supported: ["header"], scopes_supported: [REQUIRED_SCOPE] });
  });
  app.all(mcpPath, requireBearerAuth({ verifier, requiredScopes: [REQUIRED_SCOPE], resourceMetadataUrl: metadataUrl,
    expectedResource: resourceUrl }), async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
    const person = req.auth!.extra!.closedMcpPerson as ClosedMcpPerson;
    await people.run(person, async () => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        const mcp = createMcpServer();
        try {
          await mcp.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } finally { await mcp.close(); }
      } catch {
        if (!res.headersSent) res.status(500).json({ error: "internal server error" });
        else res.destroy();
      }
    });
  });
  const server = createServer(app);
  server.listen(options.port ?? 8787, options.host);
  return server;
}
