import { protectedResourceHandler, withMcpAuth } from "mcp-handler";
import { CLOSEDMCP, REQUIRED_SCOPE, createClosedMcpTokenVerifier, type ClosedMcpOptions } from "./index.js";
export { closedMcpPerson } from "./index.js";

/** Wrap a createMcpHandler result with ClosedMCP pass verification. */
export function withClosedMcpAuth(handler: (request: Request) => Response | Promise<Response>, options: ClosedMcpOptions) {
  const verify = createClosedMcpTokenVerifier(options);
  const resourceUrl = new URL(options.resource);
  return withMcpAuth(handler, async (_request, token) => {
    try {
      if (!token) return undefined;
      return await verify.verifyAccessToken(token);
    } catch {
      return undefined;
    }
  }, {
    required: true,
    requiredScopes: [REQUIRED_SCOPE],
    resourceUrl: resourceUrl.origin,
    resourceMetadataPath: `/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`,
  });
}

/** Export this as GET from the protected-resource metadata route. */
export function closedMcpResourceMetadata(options: ClosedMcpOptions) {
  createClosedMcpTokenVerifier(options);
  const metadata = protectedResourceHandler({ authServerUrls: [options.issuer ?? CLOSEDMCP], resourceUrl: options.resource });
  return async (request: Request) => {
    const response = metadata(request);
    return Response.json({ ...(await response.json() as Record<string, unknown>), scopes_supported: [REQUIRED_SCOPE] }, { headers: response.headers });
  };
}
