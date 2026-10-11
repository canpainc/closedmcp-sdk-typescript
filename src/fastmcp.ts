import type { ServerOptions } from "fastmcp";
import { CLOSEDMCP, createClosedMcpVerifier, type ClosedMcpOptions, type ClosedMcpPerson } from "./index.js";
export { closedMcpPerson } from "./index.js";

export type ClosedMcpFastMcpSession = { closedMcpPerson: ClosedMcpPerson };

/** Spread these options into a FastMCP server and use closedMcpPerson(context) in tools. */
export function closedMcpFastMcp(options: ClosedMcpOptions): Pick<ServerOptions<ClosedMcpFastMcpSession>, "authenticate" | "oauth"> {
  const verify = createClosedMcpVerifier(options);
  return {
    authenticate: async (request) => {
      try {
        return { closedMcpPerson: await verify(request.headers.authorization) };
      } catch {
        return undefined;
      }
    },
    oauth: {
      enabled: true,
      protectedResource: {
        resource: options.resource,
        authorizationServers: [options.issuer ?? CLOSEDMCP],
        bearerMethodsSupported: ["header"],
      },
    },
  };
}
