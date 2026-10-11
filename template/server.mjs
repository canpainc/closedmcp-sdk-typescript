import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closedMcpPerson, serveWithClosedMcp } from "@closedmcp/sdk";

const resource = process.env.MCP_URL;
const allowedDomains = (process.env.ALLOWED_DOMAINS ?? "").split(",").map((domain) => domain.trim()).filter(Boolean);
if (!resource) throw new Error("Set MCP_URL to this server's public MCP URL");

serveWithClosedMcp(() => {
  const mcp = new McpServer({ name: "hello", version: "1.0.0" });
  mcp.registerTool("hello", { inputSchema: {} }, async () => ({
    content: [{ type: "text", text: `Hello ${closedMcpPerson().email}` }],
  }));
  return mcp;
}, {
  resource,
  allowedDomains,
  port: Number(process.env.PORT ?? 8787),
  issuer: process.env.CLOSEDMCP_ORIGIN,
  jwksUrl: process.env.CLOSEDMCP_JWKS_URL,
});
