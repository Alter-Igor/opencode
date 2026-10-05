// #104: reading and rewriting the MCP (JSON-RPC over streamable HTTP) traffic of Keystone /mcp/dynamic.
//
// Keystone dynamic serves four meta-tools (Keystone src/mcp/tools/meta-tools.ts):
//   search-tools {query, category, limit}  -> text content: JSON {tools: [{name, ...}], services: [{tools: [names]}], ...}
//   get-tool-schema {toolName}             -> the schema of one tool
//   execute-tool {toolName, arguments}     -> runs one tool through the AI Connection relay
// Real tool names are `<namespace>__<tool>` (Keystone src/lib/mcp/downstream-tool-source.ts).
// So the gate decides on `arguments.toolName` of execute-tool and get-tool-schema, and removes
// tools the profile hides from search-tools results. Any other tools/call name is decided as a tool
// name itself (fail closed if Keystone ever serves real tools directly).
import { decide, isVisible, type Decision, type Profile } from "./policy.ts"

export const META_TOOLS = new Set(["search-tools", "get-tool-schema", "execute-tool"])
/** Responses the gate rewrites are buffered; anything bigger is refused rather than passed unchecked. */
export const MAX_FILTER_BYTES = 4 * 1024 * 1024

export type JsonRpcId = string | number | null
export type Message = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: unknown; result?: unknown; error?: unknown }

/** What the gate must do with one POSTed message. */
export type Plan =
  | { kind: "forward" }
  /** Forward, then remove hidden tools from the result of the request with this id. */
  | { kind: "filter"; id: JsonRpcId; what: "search" | "list" }
  | { kind: "decide"; id: JsonRpcId; toolName: string; args: unknown; decision: Decision; schemaOnly: boolean }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** The plan for one parsed JSON-RPC message. */
export function planMessage(profile: Profile, message: Message): Plan {
  if (message.method === "tools/list" && message.id !== undefined) return { kind: "filter", id: message.id, what: "list" }
  if (message.method !== "tools/call") return { kind: "forward" }
  const params = record(message.params) ?? {}
  const name = typeof params.name === "string" ? params.name : ""
  const args = record(params.arguments) ?? {}
  const id = message.id ?? null
  if (name === "search-tools") return { kind: "filter", id, what: "search" }
  if (name === "execute-tool" || name === "get-tool-schema") {
    const toolName = typeof args.toolName === "string" ? args.toolName : ""
    const schemaOnly = name === "get-tool-schema"
    if (toolName === "") return { kind: "decide", id, toolName: "(none)", args: {}, decision: { effect: "deny", reason: "no toolName given" }, schemaOnly }
    // Reading a schema changes nothing, so it only needs the tool to be visible.
    const decision = schemaOnly ? (isVisible(profile, toolName) ? ({ effect: "allow" } as const) : decide(profile, toolName)) : decide(profile, toolName)
    return { kind: "decide", id, toolName, args: args.arguments ?? {}, decision, schemaOnly }
  }
  return { kind: "decide", id, toolName: name, args: params.arguments ?? {}, decision: decide(profile, name), schemaOnly: false }
}

/** A tool result that tells the model the call did not run, and why. */
export function toolError(id: JsonRpcId, text: string): Message {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } }
}

/** search-tools text content with hidden tools removed. Unreadable text is replaced, never passed. */
function filterSearchText(profile: Profile, text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return JSON.stringify({ tools: [], note: "The delegation gate could not read this search result, so it was withheld." })
  }
  const body = record(parsed)
  if (body === undefined || !Array.isArray(body.tools)) return JSON.stringify({ tools: [], note: "The delegation gate could not read this search result, so it was withheld." })
  const tools = body.tools.filter((tool) => {
    const name = record(tool)?.name
    return typeof name === "string" && isVisible(profile, name)
  })
  const hidden = body.tools.length - tools.length
  const services = Array.isArray(body.services)
    ? body.services
        .map((service) => {
          const s = record(service)
          if (s === undefined) return undefined
          const names = Array.isArray(s.tools) ? s.tools.filter((n) => typeof n === "string" && isVisible(profile, n)) : []
          return names.length === 0 ? undefined : { ...s, tools: names, toolCount: names.length }
        })
        .filter((s) => s !== undefined)
    : body.services
  return JSON.stringify({
    ...body,
    tools,
    services,
    ...(hidden > 0 ? { hiddenByDelegationProfile: hidden, totalMatches: null } : {}),
  })
}

/** The response message with hidden tools removed (search-tools text, or tools/list tools). */
export function filterResult(profile: Profile, message: Message, what: "search" | "list"): Message {
  const result = record(message.result)
  if (result === undefined) return message
  if (what === "list") {
    const tools = Array.isArray(result.tools) ? result.tools.filter((t) => {
      const name = record(t)?.name
      return typeof name === "string" && (META_TOOLS.has(name) || isVisible(profile, name))
    }) : result.tools
    return { ...message, result: { ...result, tools } }
  }
  const content = Array.isArray(result.content)
    ? result.content.map((part) => {
        const p = record(part)
        return p?.type === "text" && typeof p.text === "string" ? { ...p, text: filterSearchText(profile, p.text) } : part
      })
    : result.content
  return { ...message, result: { ...result, content } }
}

/** Rewrite an SSE body: every `data:` event that is a JSON-RPC message with `id` goes through `edit`. */
export function rewriteSse(body: string, edit: (message: Message) => Message): string {
  return body
    .split(/\r?\n\r?\n/)
    .map((event) => {
      const lines = event.split(/\r?\n/)
      const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""))
      if (data.length === 0) return event
      let message: Message
      try {
        message = JSON.parse(data.join("\n")) as Message
      } catch {
        return event
      }
      const edited = edit(message)
      if (edited === message) return event
      return [...lines.filter((l) => !l.startsWith("data:")), `data: ${JSON.stringify(edited)}`].join("\n")
    })
    .join("\n\n")
}
