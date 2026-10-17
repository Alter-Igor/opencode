// #26: credential redaction for tool results before the session store keeps them.
// A model once ran a shell command that echoed a live API key; the observer redacted its own
// diagnostics log, but the tool output itself was saved in plain text and fed back to the model.
// Only high-confidence key shapes are matched, so ordinary output is not changed.
// Two callers: the Synapse plugin's `tool.execute.after` hook (the result object the model gets
// back) and `Session.updatePart` (every stored copy of a tool part: running, completed, failed).

/** Not preceded by a letter or digit: like `\b`, but a key glued to `_` (`X_sk-...`) still counts. */
const START = "(?<![A-Za-z0-9])"

type Rule = { name: string; pattern: RegExp; replace?: (match: string, ...groups: string[]) => string }

const RULES: ReadonlyArray<Rule> = [
  // Most specific first: an OpenRouter or Anthropic key also starts with "sk-".
  { name: "openrouter", pattern: new RegExp(`${START}sk-or-v1-[A-Za-z0-9]{32,}`, "g") },
  { name: "anthropic", pattern: new RegExp(`${START}sk-ant-[A-Za-z0-9_-]{32,}`, "g") },
  { name: "stripe", pattern: new RegExp(`${START}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}`, "g") },
  {
    // A real OpenAI key mixes digits, upper and lower case; a name like sk-project-management-v2 does not.
    name: "openai",
    pattern: new RegExp(`${START}sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}`, "g"),
    replace: (match) => (/\d/.test(match) && /[A-Z]/.test(match) && /[a-z]/.test(match) ? "[REDACTED:openai]" : match),
  },
  { name: "github", pattern: new RegExp(`${START}(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}`, "g") },
  { name: "github", pattern: new RegExp(`${START}github_pat_[A-Za-z0-9_]{60,}`, "g") },
  { name: "gitlab", pattern: new RegExp(`${START}glpat-[A-Za-z0-9_-]{20,}`, "g") },
  { name: "npm", pattern: new RegExp(`${START}npm_[A-Za-z0-9]{36,}`, "g") },
  { name: "huggingface", pattern: new RegExp(`${START}hf_[A-Za-z0-9]{30,}`, "g") },
  { name: "aws", pattern: new RegExp(`${START}(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])`, "g") },
  {
    name: "aws",
    pattern: /(aws_secret_access_key\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}/gi,
    replace: (_match, name) => `${name}[REDACTED:aws]`,
  },
  {
    name: "azure",
    pattern: /(AccountKey\s*=\s*)[A-Za-z0-9+/=]{20,}/g,
    replace: (_match, name) => `${name}[REDACTED:azure]`,
  },
  { name: "google", pattern: new RegExp(`${START}AIza[0-9A-Za-z_-]{35}`, "g") },
  { name: "slack", pattern: new RegExp(`${START}xox[abposr]-[A-Za-z0-9-]{10,}`, "g") },
  { name: "slack", pattern: new RegExp(`${START}xapp-\\d-[A-Za-z0-9-]{10,}`, "g") },
  { name: "synapse", pattern: new RegExp(`${START}gpapp_[A-Za-z0-9_-]{16,}`, "g") },
  // A JWT: three base64url parts, the first two starting with "eyJ" (a JSON object).
  { name: "jwt", pattern: new RegExp(`${START}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`, "g") },
  {
    name: "bearer",
    pattern: /(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g,
    replace: (match, prefix) => (match.includes("[REDACTED") ? match : `${prefix}[REDACTED:bearer]`),
  },
  {
    // user:password@ in a URL; the user name stays, the password goes. The scheme must not follow
    // a scheme character: with `\b` a long `a.b.c...` run made this rule quadratic (architect on #26).
    name: "url-credentials",
    pattern: /((?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{3,}@/gi,
    replace: (_match, prefix) => `${prefix}[REDACTED:url-credentials]@`,
  },
]

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g

/**
 * A PEM private key block, found by scanning (linear time, QA on #26: a lazy `[\s\S]*?` rule took
 * seconds on large output). A block with no END line is redacted to the end of the text, so a key
 * cut off by truncation is hidden too.
 */
function redactPem(text: string): string {
  if (!text.includes("PRIVATE KEY-----")) return text
  let out = ""
  let from = 0
  PEM_BEGIN.lastIndex = 0
  for (let begin = PEM_BEGIN.exec(text); begin; begin = PEM_BEGIN.exec(text)) {
    PEM_END.lastIndex = begin.index + begin[0].length
    const end = PEM_END.exec(text)
    out += text.slice(from, begin.index) + "[REDACTED:private-key]"
    from = end ? end.index + end[0].length : text.length
    PEM_BEGIN.lastIndex = from
    if (!end) break
  }
  return out + text.slice(from)
}

/** Replace every high-confidence credential in `text` with `[REDACTED:<kind>]`. */
export function redactSecrets(text: string): string {
  let out = redactPem(text)
  for (const rule of RULES) {
    const replace = rule.replace
    out = replace
      ? out.replace(rule.pattern, (match: string, ...groups: unknown[]) =>
          replace(match, ...groups.filter((group): group is string => typeof group === "string")),
        )
      : out.replace(rule.pattern, `[REDACTED:${rule.name}]`)
  }
  return out
}

type Scrubber = { scrub: (value: unknown) => unknown; changed: () => number }

/** Walks strings, arrays and plain writable objects; a class instance or a frozen object is left as it is. */
function scrubber(): Scrubber {
  let changed = 0
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") {
      const next = redactSecrets(value)
      if (next !== value) changed++
      return next
    }
    if (Array.isArray(value)) return Object.isFrozen(value) ? value : value.map(scrub)
    const proto = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined
    if ((proto === Object.prototype || proto === null) && !Object.isFrozen(value)) {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>))
        (value as Record<string, unknown>)[key] = scrub(inner)
    }
    return value
  }
  return { scrub, changed: () => changed }
}

/**
 * Redact a tool result in place, as the `tool.execute.after` hook receives it: the output text,
 * the title, any string the tool keeps in `metadata` (bash keeps its streamed output there), and
 * for MCP tools the text of `content` items. Returns how many fields changed.
 */
export function redactToolResult(
  result: { title?: unknown; output?: unknown; metadata?: unknown; content?: unknown } | undefined,
): number {
  if (!result) return 0
  const { scrub, changed } = scrubber()
  if (typeof result.output === "string") result.output = scrub(result.output)
  if (typeof result.title === "string") result.title = scrub(result.title)
  if (result.metadata && typeof result.metadata === "object") scrub(result.metadata)
  // An MCP tool's hook payload is the raw MCP result: core builds the stored text from its text
  // items and embedded resource text after the hook (architect on #26). Image and blob data are
  // left alone, so a binary payload is never altered.
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!item || typeof item !== "object" || Object.isFrozen(item)) continue
      const entry = item as { type?: unknown; text?: unknown; resource?: { text?: unknown } }
      if (entry.type === "text" && typeof entry.text === "string") entry.text = scrub(entry.text)
      const resource = entry.resource
      if (entry.type === "resource" && resource && typeof resource.text === "string" && !Object.isFrozen(resource))
        resource.text = scrub(resource.text)
    }
  }
  return changed()
}

/**
 * Redact a stored tool part in place (`Session.updatePart` passes its own clone). Covers every
 * state: running (streamed shell output in `metadata`), completed and failed, plus the input
 * arguments and any error text. Attachments (file data) are left alone. Returns how many fields
 * changed; any other part type is untouched.
 */
export function redactToolPart(part: { type?: unknown; state?: unknown } | undefined): number {
  if (!part || part.type !== "tool" || !part.state || typeof part.state !== "object") return 0
  const state = part.state as Record<string, unknown>
  const { scrub, changed } = scrubber()
  for (const key of ["input", "output", "title", "metadata", "error", "raw"]) {
    if (key in state) state[key] = scrub(state[key])
  }
  return changed()
}
