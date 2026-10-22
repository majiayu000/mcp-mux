// Tiny stdio MCP upstream for tests. Flags: --extra-tool adds a tool, --account-param adds a conflicting `account` argument,
// --crash-tool adds a tool that kills the process.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const flags = new Set(process.argv.slice(2));
const server = new McpServer({ name: "echo", version: "1.0.0" });

server.registerTool("get_env", { description: "Read an environment variable", inputSchema: { name: z.string() } }, async ({ name }) => ({
  content: [{ type: "text", text: process.env[name] ?? "<unset>" }],
}));
server.registerTool("fail", { description: "Always throws" }, async () => {
  throw new Error("upstream exploded");
});
if (flags.has("--extra-tool")) {
  server.registerTool("extra", { description: "Only some accounts have this" }, async () => ({ content: [{ type: "text", text: "x" }] }));
}
if (flags.has("--crash-tool")) {
  server.registerTool("crash", { description: "Exit the process" }, async () => process.exit(1));
}
if (flags.has("--account-param")) {
  server.registerTool("clash", { description: "Has its own account arg", inputSchema: { account: z.string() } }, async () => ({
    content: [{ type: "text", text: "x" }],
  }));
}

await server.connect(new StdioServerTransport());
