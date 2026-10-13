import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

export const CLOSEDMCP = "https://closedmcp.com";
const LEGACY_CLOSEDMCP = "https://closedmcp.canpai.io";

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

export function createClosedMcpVerifier(options: ClosedMcpOptions) {
  const { resource } = options;
  const url = new URL(resource);
  if (!resource || !["http:", "https:"].includes(url.protocol) || url.hash || url.search) {
    throw new Error("resource must be an absolute HTTP(S) MCP URL without query or fragment");
  }
  const allowed = new Set(options.allowedDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean));
  if (allowed.size === 0) throw new Error("allowedDomains must name at least one company");
  const issuers = options.issuer ? [options.issuer] : [CLOSEDMCP, LEGACY_CLOSEDMCP];
  const keys = new Map(issuers.map((issuer) => [issuer, createRemoteJWKSet(
    new URL(options.jwksUrl ?? `${issuer}/.well-known/jwks.json`),
    { cooldownDuration: 30_000, timeoutDuration: 5_000 },
  )]));

  return async (authorization: string | undefined): Promise<ClosedMcpPerson> => {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
    if (!token) throw new Error("No sign-in token");
    const issuer = decodeJwt(token).iss;
    const issuerKeys = issuer && keys.get(issuer);
    if (!issuerKeys) throw new Error("Unknown sign-in issuer");
    const { payload } = await jwtVerify(token, issuerKeys, {
      algorithms: ["EdDSA"],
      issuer,
      audience: resource,
      maxTokenAge: "5m",
      requiredClaims: ["iss", "aud", "sub", "email", "domain", "org", "iat", "exp", "jti"],
    });
    if (payload.aud !== resource) throw new Error("Wrong MCP audience");
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.exp - payload.iat > 300 || payload.exp <= payload.iat) {
      throw new Error("Sign-in token lifetime is invalid");
    }
    if (typeof payload.sub !== "string" || !payload.sub || typeof payload.email !== "string" || !payload.email ||
        typeof payload.domain !== "string" || !payload.domain || typeof payload.org !== "string" || !payload.org ||
        typeof payload.jti !== "string" || !payload.jti || (payload.client !== undefined && typeof payload.client !== "string")) {
      throw new Error("Sign-in token claims are invalid");
    }
    if (!allowed.has(payload.domain.toLowerCase())) throw new Error("Company is not allowed");
    return { id: payload.sub, email: payload.email, company: payload.domain, org: payload.org, aiApp: payload.client };
  };
}

export interface ServeOptions extends ClosedMcpOptions {
  /** Port used by the built-in Node HTTP server. Defaults to 8787. */
  port?: number;
  host?: string;
}

/** Serve a fresh McpServer per request with a pass checked on every MCP request. */
export function serveWithClosedMcp(createMcpServer: () => McpServer, options: ServeOptions): Server {
  const verify = createClosedMcpVerifier(options);
  const resourceUrl = new URL(options.resource);
  const mcpPath = resourceUrl.pathname;
  const metadataPath = `/.well-known/oauth-protected-resource${mcpPath === "/" ? "" : mcpPath}`;
  const metadataUrl = `${resourceUrl.origin}${metadataPath}`;
  const metadata = {
    resource: options.resource,
    authorization_servers: [options.issuer ?? CLOSEDMCP],
    bearer_methods_supported: ["header"],
  };
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && (path === metadataPath || path === "/.well-known/oauth-protected-resource")) {
      send(res, 200, metadata);
      return;
    }
    if (path !== mcpPath) {
      send(res, 404, { error: "not found" });
      return;
    }
    let person: ClosedMcpPerson;
    try {
      person = await verify(req.headers.authorization);
    } catch {
      send(res, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${metadataUrl}"` });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "method not allowed" });
      return;
    }
    await people.run(person, async () => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        const mcp = createMcpServer();
        try {
          await mcp.connect(transport);
          await transport.handleRequest(req, res);
        } finally {
          await mcp.close();
        }
      } catch {
        if (!res.headersSent) send(res, 500, { error: "internal server error" });
        else res.destroy();
      }
    });
  });
  server.listen(options.port ?? 8787, options.host);
  return server;
}
