import type { ServerOptions } from "fastmcp";
import { InsufficientScopeError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { CLOSEDMCP, REQUIRED_SCOPE, createClosedMcpVerifier, type ClosedMcpOptions, type ClosedMcpPerson } from "./index.js";
export { closedMcpPerson } from "./index.js";

export type ClosedMcpFastMcpSession = { closedMcpPerson: ClosedMcpPerson };

/** Spread these options into a FastMCP server and use closedMcpPerson(context) in tools. */
export function closedMcpFastMcp(options: ClosedMcpOptions): Pick<ServerOptions<ClosedMcpFastMcpSession>, "authenticate" | "oauth"> {
  const verify = createClosedMcpVerifier(options);
  return {
    authenticate: async (request) => {
      try {
        return { closedMcpPerson: await verify(request.headers.authorization) };
      } catch (error) {
        if (error instanceof InsufficientScopeError) {
          const url = new URL(options.resource);
          const metadata = `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`;
          throw Response.json({ error: "insufficient_scope" }, { status: 403,
            headers: { "www-authenticate": `Bearer error="insufficient_scope", scope="${REQUIRED_SCOPE}", resource_metadata="${metadata}"` } });
        }
        return undefined;
      }
    },
    oauth: {
      enabled: true,
      protectedResource: {
        resource: options.resource,
        authorizationServers: [options.issuer ?? CLOSEDMCP],
        bearerMethodsSupported: ["header"],
        scopesSupported: [REQUIRED_SCOPE],
      },
    },
  };
}
