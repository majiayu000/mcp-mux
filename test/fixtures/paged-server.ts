// Synthetic stdio upstream. Each new process reads a snapshot, so tests can change the inventory before reconnecting.
import { appendFileSync, readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

const settings: { pages: Tool[][]; cursors?: string[]; failPage?: number; outputs?: Record<string, CallToolResult>; trace: string } = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
process.on("exit", () => appendFileSync(settings.trace + ".closed", "closed\n"));
process.on("SIGTERM", () => process.exit(0));
const cursors = settings.cursors ?? settings.pages.slice(1).map((_, i) => `page:${i + 1}`);
const server = new Server({ name: "paged", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  const cursor = req.params?.cursor;
  const index = cursor === undefined ? 0 : cursors.indexOf(cursor) + 1;
  appendFileSync(settings.trace, JSON.stringify({ cursor: cursor ?? null, _meta: req.params?._meta }) + "\n");
  if (index === settings.failPage) throw new Error("later page failed");
  if (cursor !== undefined && index === 0) throw new Error("unknown cursor");
  return { tools: settings.pages[index] ?? [], ...(index < cursors.length ? { nextCursor: cursors[index] } : {}) };
});
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  appendFileSync(settings.trace + ".calls", JSON.stringify({ name: req.params.name }) + "\n");
  if (req.params.name === "crash") process.exit(1);
  if (!settings.pages.flat().some((tool) => tool.name === req.params.name)) throw new Error("unknown tool");
  return settings.outputs?.[req.params.name] ?? { content: [{ type: "text", text: req.params.name }], _meta: { received: req.params.arguments } };
});
await server.connect(new StdioServerTransport());
