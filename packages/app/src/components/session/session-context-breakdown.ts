import type { Message, Part } from "@opencode-ai/sdk/v2/client"

export type ContextUsageRow = {
  label: string
  tokens: number
}

export type PresentedContextUsage = ContextUsageRow & {
  percent: number
}

export function contextUsageFromParts(
  parts: readonly { type: string; synthetic?: boolean; metadata?: { contextUsage?: unknown } }[],
): ContextUsageRow[] {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (!part || part.type !== "text" || !part.synthetic) continue
    const rows = part.metadata?.contextUsage
    if (!Array.isArray(rows)) continue
    return rows.flatMap((row) => {
      if (!row || typeof row !== "object") return []
      const label = "label" in row ? row.label : undefined
      const tokens = "tokens" in row ? row.tokens : undefined
      if (typeof label !== "string" || typeof tokens !== "number") return []
      return [{ label, tokens }]
    })
  }
  return []
}

export function presentContextUsage(rows: ContextUsageRow[], input: number): PresentedContextUsage[] {
  const clean = rows.filter((row) => row.tokens > 0 && row.label.trim())
  if (!input || clean.length === 0) return []
  const estimated = clean.reduce((sum, row) => sum + row.tokens, 0)
  if (estimated <= input) {
    const leftover = input - estimated
    const all = leftover > 0 ? [...clean, { label: "Left over", tokens: leftover }] : clean
    return all.map((row) => ({ ...row, percent: toPercentLabel(row.tokens, input) }))
  }
  const scale = input / estimated
  const scaled = clean.map((row) => ({ ...row, tokens: Math.floor(row.tokens * scale) }))
  const used = scaled.reduce((sum, row) => sum + row.tokens, 0)
  const withGap = input - used > 0 ? [...scaled, { label: "Left over", tokens: input - used }] : scaled
  return withGap.map((row) => ({ ...row, percent: toPercentLabel(row.tokens, input) }))
}

export type SessionContextBreakdownKey = "system" | "user" | "assistant" | "tool" | "other"

export type SessionContextBreakdownSegment = {
  key: SessionContextBreakdownKey
  tokens: number
  width: number
  percent: number
}

const estimateTokens = (chars: number) => Math.ceil(chars / 4)
const toPercent = (tokens: number, input: number) => (tokens / input) * 100
const toPercentLabel = (tokens: number, input: number) => Math.round(toPercent(tokens, input) * 10) / 10

const charsFromUserPart = (part: Part) => {
  if (part.type === "text") return part.text.length
  if (part.type === "file") return part.source?.text.value.length ?? 0
  if (part.type === "agent") return part.source?.value.length ?? 0
  return 0
}

const charsFromAssistantPart = (part: Part) => {
  if (part.type === "text") return { assistant: part.text.length, tool: 0 }
  if (part.type === "reasoning") return { assistant: part.text.length, tool: 0 }
  if (part.type !== "tool") return { assistant: 0, tool: 0 }

  const input = Object.keys(part.state.input).length * 16
  if (part.state.status === "pending") return { assistant: 0, tool: input + part.state.raw.length }
  if (part.state.status === "completed") return { assistant: 0, tool: input + part.state.output.length }
  if (part.state.status === "error") return { assistant: 0, tool: input + part.state.error.length }
  return { assistant: 0, tool: input }
}

const build = (
  tokens: { system: number; user: number; assistant: number; tool: number; other: number },
  input: number,
) => {
  return [
    {
      key: "system",
      tokens: tokens.system,
    },
    {
      key: "user",
      tokens: tokens.user,
    },
    {
      key: "assistant",
      tokens: tokens.assistant,
    },
    {
      key: "tool",
      tokens: tokens.tool,
    },
    {
      key: "other",
      tokens: tokens.other,
    },
  ]
    .filter((x) => x.tokens > 0)
    .map((x) => ({
      key: x.key,
      tokens: x.tokens,
      width: toPercent(x.tokens, input),
      percent: toPercentLabel(x.tokens, input),
    })) as SessionContextBreakdownSegment[]
}

export function estimateSessionContextBreakdown(args: {
  messages: Message[]
  parts: Record<string, Part[] | undefined>
  input: number
  systemPrompt?: string
}) {
  if (!args.input) return []

  const counts = args.messages.reduce(
    (acc, msg) => {
      const parts = args.parts[msg.id] ?? []
      if (msg.role === "user") {
        const user = parts.reduce((sum, part) => sum + charsFromUserPart(part), 0)
        return { ...acc, user: acc.user + user }
      }

      if (msg.role !== "assistant") return acc
      const assistant = parts.reduce(
        (sum, part) => {
          const next = charsFromAssistantPart(part)
          return {
            assistant: sum.assistant + next.assistant,
            tool: sum.tool + next.tool,
          }
        },
        { assistant: 0, tool: 0 },
      )
      return {
        ...acc,
        assistant: acc.assistant + assistant.assistant,
        tool: acc.tool + assistant.tool,
      }
    },
    {
      system: args.systemPrompt?.length ?? 0,
      user: 0,
      assistant: 0,
      tool: 0,
    },
  )

  const tokens = {
    system: estimateTokens(counts.system),
    user: estimateTokens(counts.user),
    assistant: estimateTokens(counts.assistant),
    tool: estimateTokens(counts.tool),
  }
  const estimated = tokens.system + tokens.user + tokens.assistant + tokens.tool

  if (estimated <= args.input) {
    return build({ ...tokens, other: args.input - estimated }, args.input)
  }

  const scale = args.input / estimated
  const scaled = {
    system: Math.floor(tokens.system * scale),
    user: Math.floor(tokens.user * scale),
    assistant: Math.floor(tokens.assistant * scale),
    tool: Math.floor(tokens.tool * scale),
  }
  const total = scaled.system + scaled.user + scaled.assistant + scaled.tool
  return build({ ...scaled, other: Math.max(0, args.input - total) }, args.input)
}
