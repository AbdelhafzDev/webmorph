import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolExecutor } from './executor.js';
import { WEBMORPH_VERSION } from '../version.js';

export interface McpServerOptions {
  executor: ToolExecutor;
  siteId: string;
  origin: string;
}

/**
 * Expose a site's published tools over the Model Context Protocol. Tool
 * schemas come straight from the registry; every call goes through the
 * executor's policy, concurrency and degradation logic.
 */
export function createMcpServer(options: McpServerOptions): Server {
  const server = new Server({ name: `webmorph:${options.siteId}`, version: WEBMORPH_VERSION }, { capabilities: { tools: {} }, instructions: `Tools for ${options.origin}, generated and validated by WebMorph. All tools are read-only and return structured results; errors carry a code such as SITE_CHANGED or TOOL_UNAVAILABLE.` });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const published = await options.executor.registry.listPublished();
    // API tools first: an agent reading the list top-down reaches the browser-free route before its fallback.
    const ordered = [...published].sort((a, b) => Number(b.tool.transport === 'http') - Number(a.tool.transport === 'http') || a.tool.name.localeCompare(b.tool.name));
    return {
      tools: ordered.map((entry) => ({
        name: entry.tool.name,
        title: entry.tool.title,
        description: `${entry.tool.description}\n\nSite: ${options.origin}. Expected outcome: ${entry.tool.expectedOutcome}.`,
        inputSchema: entry.tool.inputSchema as { type: 'object'; properties?: Record<string, unknown>; required?: string[] },
        outputSchema: entry.tool.outputSchema as { type: 'object'; properties?: Record<string, unknown>; required?: string[] },
        annotations: { title: entry.tool.title, readOnlyHint: true, destructiveHint: false, idempotentHint: entry.tool.idempotent, openWorldHint: true },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await options.executor.call(name, args);
    if (result.ok && result.output && typeof result.output === 'object') {
      const output = result.output as Record<string, unknown>;
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    }
    const error = { code: result.errorCode ?? 'RUNTIME_ERROR', message: result.errorMessage ?? 'tool failed', runId: result.runId, ...(result.status ? { toolStatus: result.status } : {}) };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
  });

  return server;
}

/** Serve over stdio. stdout belongs to the protocol; logs must go to stderr. */
export async function serveStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
