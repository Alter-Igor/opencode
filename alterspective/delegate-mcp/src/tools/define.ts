// MOD-04 tool registration helper: every tool is audited (one log line per call, MCP-STANDARDS
// :670) and every failure is shaped by `fail()` — a tool handler never throws to the SDK.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { z } from "zod"
import type { ToolContext } from "./context.ts"
import { fail, type ToolResult } from "./shape.ts"

export type ToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }

export type ToolSpec<S extends z.ZodRawShape> = {
  name: string
  title: string
  description: string
  input: S
  annotations?: ToolAnnotations
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext, correlationId: string): Promise<ToolResult>
}

export function defineTool<S extends z.ZodRawShape>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec
}

export function registerTools(server: McpServer, ctx: ToolContext, specs: Array<ToolSpec<z.ZodRawShape>>): void {
  for (const spec of specs) {
    server.registerTool(
      spec.name,
      { title: spec.title, description: spec.description, inputSchema: spec.input, annotations: spec.annotations },
      async (args: Record<string, unknown>) => {
        const correlationId = ctx.correlationId()
        const started = Date.now()
        try {
          const result = await spec.run(args as never, ctx, correlationId)
          ctx.log.log("info", "tool", "tool call", { tool: spec.name, correlationId, ms: Date.now() - started, isError: result.isError === true })
          return result
        } catch (error) {
          const result = fail(error)
          ctx.log.log("warn", "tool", "tool call failed", { tool: spec.name, correlationId, ms: Date.now() - started, code: String(result.structuredContent?.code ?? "") })
          return result
        }
      },
    )
  }
}
