import { protectedResourceHandler, withMcpAuth } from "mcp-handler";
import { CLOSEDMCP, createClosedMcpVerifier, type ClosedMcpOptions } from "./index.js";
export { closedMcpPerson } from "./index.js";

/** Wrap a createMcpHandler result with ClosedMCP pass verification. */
export function withClosedMcpAuth(handler: (request: Request) => Response | Promise<Response>, options: ClosedMcpOptions) {
  const verify = createClosedMcpVerifier(options);
  const resourceUrl = new URL(options.resource);
  return withMcpAuth(handler, async (_request, token) => {
    try {
      const person = await verify(token && `Bearer ${token}`);
      return { token: token!, clientId: person.id, scopes: [], extra: { closedMcpPerson: person } };
    } catch {
      return undefined;
    }
  }, {
    required: true,
    resourceUrl: resourceUrl.origin,
    resourceMetadataPath: `/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`,
  });
}

/** Export this as GET from the protected-resource metadata route. */
export function closedMcpResourceMetadata(options: ClosedMcpOptions) {
  createClosedMcpVerifier(options);
  return protectedResourceHandler({ authServerUrls: [options.issuer ?? CLOSEDMCP], resourceUrl: options.resource });
}
