// MOD-04 output shaping (technical-design §5): every tool result is short JSON plus a one-line
// summary; text that came from a session or the box lives only under `untrusted`; errors are
// {code, message, action}. Results are capped so one call cannot flood the client's context.
//
// The cap applies to the text and to structuredContent alike (W3A-02 / W3C-04). A result over the
// cap is never cut mid-JSON: whole array items are dropped (largest array first) and a
// `_truncated` list says what went. Paging keys (`next`, `cursor`, `more`, ...) are never
// dropped and come first, so a client can always page on.
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { scrub } from "../shared/log.ts"
import { stripUnsafe } from "../shared/text.ts"

/** ~8k tokens. Claude Code warns above 10k and truncates at 25k (MAX_MCP_OUTPUT_TOKENS). */
export const MAX_RESULT_CHARS = 32_000
/** Per untrusted text field. */
export const MAX_UNTRUSTED_CHARS = 8_000
/** Keys a client needs to page on. Kept whatever else is dropped, and placed first. */
export const PAGE_KEYS = ["next", "cursor", "more", "still_running", "expired", "truncated"] as const
export const TRUNCATION_HINT = "page with a cursor or a smaller limit"

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** One dropped part of a result: `field` is a path such as `events` or `sessions[0].pending`. */
export type Truncation = { field: string; omitted: number; hint: string }

export type OkOptions = {
  /** Character cap for the whole text result. Default MAX_RESULT_CHARS. */
  maxChars?: number
}

/** Wrap session/box text so a client never mistakes it for bridge output. Hidden characters go first. */
export function untrusted(text: string | undefined, max = MAX_UNTRUSTED_CHARS): { text: string; truncated: boolean } | undefined {
  if (text === undefined) return undefined
  const clean = stripUnsafe(text)
  return clean.length > max ? { text: clean.slice(0, max), truncated: true } : { text: clean, truncated: false }
}

/** Keep whole items, in order, while their JSON fits `budgetChars` (one extra char per separator). */
export function fitList<T>(items: readonly T[], budgetChars: number, size: (item: T) => number = jsonLength): { kept: T[]; omitted: number } {
  let used = 0
  let count = 0
  for (const item of items) {
    const next = used + size(item) + (count > 0 ? 1 : 0)
    if (next > budgetChars) break
    used = next
    count++
  }
  return { kept: items.slice(0, count), omitted: items.length - count }
}

function jsonLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0
}

/** A successful tool result. `summary` is bridge-authored text only. */
export function ok(summary: string, data: Record<string, unknown> = {}, options: OkOptions = {}): ToolResult {
  const fitted = fitResult(summary, data, options.maxChars ?? MAX_RESULT_CHARS)
  return { content: [{ type: "text", text: fitted.text }], structuredContent: fitted.data }
}

/** A failed tool result. Unknown errors become upstream_error with no internals exposed (ERR-MSG-03). */
export function fail(error: unknown): ToolResult {
  const known = isDelegateError(error)
    ? error
    : new DelegateError("upstream_error", "The bridge hit an unexpected error.", "Retry; if it repeats, run oc_doctor.", scrub(String(error)))
  const data = known.toResult()
  return { content: [{ type: "text", text: `${data.code}: ${data.message} (${data.action})` }], structuredContent: data, isError: true }
}

// ---- fitting -------------------------------------------------------------------------------

type Node = Record<string, unknown> | unknown[]
type Path = Array<string | number>
type Fitted = { text: string; data: Record<string, unknown> }

const TRIMMED_NOTE = " (trimmed to fit; see _truncated)"

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const isPageKey = (key: string): boolean => (PAGE_KEYS as readonly string[]).includes(key)

function textOf(summary: string, data: Record<string, unknown>): string {
  return `${summary}\n${JSON.stringify(data, null, 2)}`
}

/** Paging keys first, then `_truncated` (when there is one), then the rest in their own order. */
function ordered(data: Record<string, unknown>, marks: Truncation[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of PAGE_KEYS) if (key in data) out[key] = data[key]
  if (marks.length) out._truncated = marks
  for (const [key, value] of Object.entries(data)) if (!(key in out)) out[key] = value
  return out
}

/** `summary` + `data` as one text of at most `max` chars, and the same (possibly trimmed) data. */
export function fitResult(summary: string, data: Record<string, unknown>, max = MAX_RESULT_CHARS): Fitted {
  const whole = textOf(summary, data)
  if (whole.length <= max) return { text: whole, data }
  // Work on a JSON copy: it is exactly what a client receives, and the caller's object is untouched.
  const copy = JSON.parse(JSON.stringify(data)) as Record<string, unknown>
  const noted = summary + TRIMMED_NOTE
  const trimmed = trimArrays(noted, copy, max)
  if (trimmed) return trimmed
  return keepPagingOnly(noted, copy, max)
}

/** Trim arrays, largest first, until the result fits. Undefined when trimming every array is not enough. */
function trimArrays(summary: string, root: Record<string, unknown>, max: number): Fitted | undefined {
  const marks: Truncation[] = []
  const settled = new Set<string>()
  const fits = (): boolean => textOf(summary, ordered(root, marks)).length <= max
  for (;;) {
    const target = largestArray(root, settled)
    if (!target) return undefined
    const field = fieldName(target.path)
    settled.add(field)
    const keep = keepCount(target.items, field, marks, fits)
    if (keep < target.items.length) {
      marks.push({ field, omitted: target.items.length - keep, hint: TRUNCATION_HINT })
      target.items.splice(keep)
    }
    if (fits()) {
      const data = ordered(root, marks)
      return { text: textOf(summary, data), data }
    }
  }
}

/**
 * The longest prefix of `items` (edited in place while measuring, then restored) that fits, with
 * its `_truncated` entry counted. At least 1 when the first item holds arrays that can be trimmed
 * next, so one oversized item is trimmed inside rather than dropped whole.
 */
function keepCount(items: unknown[], field: string, marks: Truncation[], fits: () => boolean): number {
  const all = items.slice()
  const tryKeep = (n: number): boolean => {
    items.splice(0, items.length, ...all.slice(0, n))
    marks.push({ field, omitted: all.length - n, hint: TRUNCATION_HINT })
    const result = fits()
    marks.pop()
    return result
  }
  let low = 0
  let high = all.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (tryKeep(mid)) low = mid
    else high = mid - 1
  }
  items.splice(0, items.length, ...all)
  return low === 0 && holdsArray(all[0]) ? 1 : low
}

type Found = { path: Path; items: unknown[]; size: number }

/** The biggest array (by JSON size) not yet trimmed, never inside a paging key. */
function largestArray(root: Record<string, unknown>, settled: Set<string>): Found | undefined {
  let best: Found | undefined
  const visit = (node: Node, path: Path): void => {
    const entries: Array<[string | number, unknown]> = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node)
    for (const [key, value] of entries) {
      if (path.length === 0 && typeof key === "string" && isPageKey(key)) continue
      const at = [...path, key]
      if (Array.isArray(value) && value.length > 0 && !settled.has(fieldName(at))) {
        const size = jsonLength(value)
        if (!best || size > best.size) best = { path: at, items: value, size }
      }
      if (Array.isArray(value) || isRecord(value)) visit(value, at)
    }
  }
  visit(root, [])
  return best
}

function holdsArray(value: unknown): boolean {
  if (Array.isArray(value)) return true
  return isRecord(value) && Object.values(value).some(holdsArray)
}

function fieldName(path: Path): string {
  return path.map((key, i) => (typeof key === "number" ? `[${key}]` : i === 0 ? key : `.${key}`)).join("")
}

/** Last resort: only the paging keys survive. Past that, only the marker (and a cut summary). */
function keepPagingOnly(summary: string, root: Record<string, unknown>, max: number): Fitted {
  const dropped = Object.keys(root).filter((key) => !isPageKey(key))
  const marks: Truncation[] = [{ field: dropped.join(",") || "(result)", omitted: dropped.length, hint: TRUNCATION_HINT }]
  const paging: Record<string, unknown> = {}
  for (const key of PAGE_KEYS) if (key in root) paging[key] = root[key]
  const data = ordered(paging, marks)
  if (textOf(summary, data).length <= max) return { text: textOf(summary, data), data }
  const bare = ordered({}, [{ field: "(result)", omitted: Object.keys(root).length, hint: TRUNCATION_HINT }])
  const room = Math.max(0, max - textOf("", bare).length)
  const text = textOf(summary.slice(0, room), bare)
  return { text: text.slice(0, max), data: bare }
}
