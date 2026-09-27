import type { ModelMessage } from "ai"

export type ContextUsageRow = {
  label: string
  tokens: number
}

const CHARS_PER_TOKEN = 4

export function measureContextUsage(input: {
  messages: ModelMessage[]
  tools: Record<string, { description?: string; inputSchema?: unknown }>
}): ContextUsageRow[] {
  const rows = [
    ...systemRows(input.messages),
    ...messageRows(input.messages),
    ...toolRows(input.tools),
  ]
  return rows.filter((row) => row.tokens > 0)
}

function systemRows(messages: ModelMessage[]) {
  const text = messages
    .filter((message) => message.role === "system")
    .map((message) => textOf(message.content))
    .join("\n")
  if (!text.trim()) return []

  const found: ContextUsageRow[] = []
  let rest = text
  const take = (label: string, pattern: RegExp) => {
    const match = rest.match(pattern)
    if (!match) return
    found.push({ label, tokens: estimate(match[0].length) })
    rest = rest.replace(match[0], "")
  }

  take("MCP notes", /<mcp_instructions>[\s\S]*?<\/mcp_instructions>/)
  take("Skill lookup", /## Skills[\s\S]*?(?=\n## |\nInstructions from:|$)/)
  take("Standards", /## Alterspective Standards Awareness[\s\S]*$/)
  const instructions = rest.match(/Instructions from:[\s\S]*/)
  if (instructions) {
    found.push({ label: "Instructions", tokens: estimate(instructions[0].length) })
    rest = rest.replace(instructions[0], "")
  }
  if (rest.trim()) found.push({ label: "System text", tokens: estimate(rest.length) })
  return found
}

function messageRows(messages: ModelMessage[]) {
  const user = messages
    .filter((message) => message.role === "user")
    .reduce((sum, message) => sum + textOf(message.content).length, 0)
  const assistant = messages
    .filter((message) => message.role === "assistant")
    .reduce((sum, message) => sum + textOf(message.content).length, 0)
  return [
    { label: "Your messages", tokens: estimate(user) },
    { label: "Earlier replies", tokens: estimate(assistant) },
  ]
}

function toolRows(tools: Record<string, { description?: string; inputSchema?: unknown }>) {
  const groups = new Map<string, number>()
  for (const [name, tool] of Object.entries(tools)) {
    if (name === "invalid") continue
    const label = toolGroup(name)
    groups.set(label, (groups.get(label) ?? 0) + toolChars(name, tool))
  }
  return [...groups.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([label, chars]) => ({ label, tokens: estimate(chars) }))
}

function toolGroup(name: string) {
  const id = name.toLowerCase()
  if (id.includes("rag")) return "RAG tools"
  if (id.startsWith("cas-") || id.startsWith("cas_") || id.includes("alterspective-agent") || id.includes("alterspective_agent"))
    return "CAS tools"
  if (id.includes("keystone")) return "Keystone tools"
  if (id.includes("playwright")) return "Playwright tools"
  if (id.includes("imprint")) return "Imprint tools"
  if (id.includes("vault")) return "Vault tools"
  return "Built-in tools"
}

function toolChars(name: string, tool: { description?: string; inputSchema?: unknown }) {
  return name.length + (tool.description?.length ?? 0) + schemaChars(tool.inputSchema)
}

function schemaChars(schema: unknown) {
  if (!schema || typeof schema !== "object") return 0
  const record = schema as Record<string, unknown>
  const json = "jsonSchema" in record ? record.jsonSchema : record
  try {
    return JSON.stringify(json).length
  } catch {
    return 0
  }
}

function textOf(content: ModelMessage["content"]) {
  if (typeof content === "string") return content
  return content
    .map((part) => {
      if (part.type === "text") return part.text
      return ""
    })
    .join("")
}

function estimate(chars: number) {
  if (chars <= 0) return 0
  return Math.ceil(chars / CHARS_PER_TOKEN)
}
