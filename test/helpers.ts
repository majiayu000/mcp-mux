import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Mux } from "../src/mux.ts";

export const tmp = (prefix: string) => mkdtemp(join(tmpdir(), `mcp-mux-${prefix}-`));

// Downstream client wired to a mux in-process.
export async function clientFor(mux: Mux) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mux.server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

export const text = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;
