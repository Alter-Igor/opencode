// #26: credential redaction for tool output before the session store keeps it.
// A model once ran a shell command that echoed a live API key; the observer redacted its own
// diagnostics log, but the tool output itself was saved in plain text and fed back to the model.
// Only high-confidence key shapes are matched, so ordinary output is never changed.

const RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // Most specific first: an OpenRouter or Anthropic key also starts with "sk-".
  { name: "openrouter", pattern: /\bsk-or-v1-[A-Za-z0-9]{32,}/g },
  { name: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}/g },
  { name: "openai", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { name: "github", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { name: "github", pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { name: "aws", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "google", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "slack", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: "synapse", pattern: /\bgpapp_[A-Za-z0-9_-]{16,}/g },
  // A JWT: three base64url parts, the first two starting with "eyJ" (a JSON object).
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
]

/** Replace every high-confidence credential in `text` with `[REDACTED:<kind>]`. */
export function redactSecrets(text: string): string {
  let out = text
  for (const rule of RULES) out = out.replace(rule.pattern, `[REDACTED:${rule.name}]`)
  return out
}

/**
 * Redact a tool result in place, as the `tool.execute.after` hook receives it: the output text,
 * the title, and any string the tool keeps in `metadata` (bash keeps its streamed output there).
 * Returns how many fields changed, so the caller can log that something was hidden.
 */
export function redactToolResult(result: { title?: unknown; output?: unknown; metadata?: unknown } | undefined): number {
  if (!result) return 0
  let changed = 0
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") {
      const next = redactSecrets(value)
      if (next !== value) changed++
      return next
    }
    if (Array.isArray(value)) return value.map(scrub)
    // Only plain, writable objects: a class instance or a frozen object is left as it is.
    const proto = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined
    if ((proto === Object.prototype || proto === null) && !Object.isFrozen(value)) {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) (value as Record<string, unknown>)[key] = scrub(inner)
    }
    return value
  }
  if (typeof result.output === "string") result.output = scrub(result.output)
  if (typeof result.title === "string") result.title = scrub(result.title)
  if (result.metadata && typeof result.metadata === "object") scrub(result.metadata)
  return changed
}
