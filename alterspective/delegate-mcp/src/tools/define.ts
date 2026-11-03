// MOD-04 tool registration helper: every tool is audited (one log line per call, MCP-STANDARDS
// :670) and every failure is shaped by `fail()` — a tool handler never throws to the SDK.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ToolContext } from "./context.ts"
import { fail, type ToolResult } from "./shape.ts"
import { isDelegateError } from "../shared/errors.ts"
import { scrub } from "../shared/log.ts"

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

/**
 * One tool. The SDK has already validated the arguments against `input`; parsing them again with
 * the same schema gives the handler its real type without a cast (W3A-19).
 */
function registerOne(server: McpServer, ctx: ToolContext, spec: ToolSpec<z.ZodRawShape>): void {
  const schema = z.object(spec.input)
  server.registerTool(spec.name, { title: spec.title, description: spec.description, inputSchema: spec.input, annotations: spec.annotations }, async (raw: unknown) => {
    const correlationId = ctx.correlationId()
    const started = Date.now()
    try {
      const result = await spec.run(schema.parse(raw), ctx, correlationId)
      ctx.log.log("info", "tool", "tool call", { tool: spec.name, correlationId, ms: Date.now() - started, isError: result.isError === true })
      return result
    } catch (error) {
      const result = fail(error)
      ctx.log.log("warn", "tool", "tool call failed", { tool: spec.name, correlationId, ms: Date.now() - started, code: String(result.structuredContent?.code ?? ""), detail: failureDetail(error) })
      return result
    }
  })
}

export function registerTools(server: McpServer, ctx: ToolContext, specs: Array<ToolSpec<z.ZodRawShape>>): void {
  for (const spec of specs) registerOne(server, ctx, spec)
}

// The caller sees only the safe message (ERR-MSG-03); the operator log keeps the scrubbed cause.
function failureDetail(error: unknown): string {
  const detail = isDelegateError(error) ? (error.detail ?? error.message) : String(error)
  return scrub(detail).slice(0, 500)
}
