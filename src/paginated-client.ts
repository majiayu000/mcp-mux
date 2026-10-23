import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AnySchema, SchemaOutput } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

// Aggregate before Client.listTools caches metadata, so every tool retains the SDK's call validation.
export class PaginatedClient extends Client {
  override async request<T extends AnySchema>(
    request: Parameters<Client["request"]>[0],
    resultSchema: T,
    options?: RequestOptions,
  ): Promise<SchemaOutput<T>> {
    if (request.method !== "tools/list" || resultSchema !== ListToolsResultSchema || request.params?.cursor !== undefined) {
      return super.request(request, resultSchema, options);
    }

    const first = await super.request(request, ListToolsResultSchema, options);
    const tools = [...first.tools];
    const cursors = new Set<string>();
    let cursor = first.nextCursor;
    while (cursor !== undefined) {
      if (cursors.has(cursor)) throw new Error("upstream tools/list returned a repeated cursor");
      cursors.add(cursor);
      const page = await super.request({ ...request, params: { ...request.params, cursor } }, ListToolsResultSchema, options);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    }
    // The identity check above limits this result to the SDK's canonical list-tools schema.
    return { ...first, tools, nextCursor: undefined } as SchemaOutput<T>;
  }
}
