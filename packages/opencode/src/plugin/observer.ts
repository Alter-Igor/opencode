import * as fs from "node:fs/promises"
import * as path from "node:path"
import { truthy } from "@opencode-ai/core/flag/flag"
import { getLatestSynapseServing } from "./synapse"
import { redactSecrets } from "./secret-redaction"

export interface ToolExecutionRecord {
  callId: string
  tool: string
  args: any
  startTime: number
  endTime?: number
  durationMs?: number
  outputSnippet?: string
  isError?: boolean
  errorMessage?: string
  /** Set when the result had the MCP shape (`content` items); see `isMcpRecord`. */
  mcp?: boolean
}

/** A raw MCP `CallToolResult`, which core hands to `tool.execute.after` for MCP tools. */
function isMcpResult(value: unknown): value is { content: unknown[]; isError?: unknown } {
  return !!value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)
}

/**
 * #18: error texts core writes when the user stops or refuses a call, or a permission rule blocks
 * it (`processor.ts` abort, `core/src/v1/permission.ts`, `question/index.ts`).
 */
const NOT_A_FAILURE = [
  "Tool execution aborted",
  "The user rejected permission to use this specific tool call",
  "The user has specified a rule which prevents you from using this specific tool call",
  "The user dismissed this question",
]

/**
 * #209: an MCP call stopped by its abort signal (the user stopped the reply) fails with the SDK's
 * wrapped text, e.g. `MCP error -32001: AbortError: The operation was aborted.` (Bun) or
 * "... This operation was aborted" (Node), so it is matched anywhere in the text, not as a prefix.
 * A real timeout reads `MCP error -32001: Request timed out` and still counts.
 */
const ABORTED = /operation was aborted/i

/** #18: a `message.part.updated` event for a tool part that failed, as the observer needs it. */
export function failedToolFromEvent(event: {
  type: string
  properties?: any
}): { sessionID: string; callID: string; tool: string; error: string } | undefined {
  if (event.type !== "message.part.updated") return undefined
  const part = event.properties?.part
  if (!part || part.type !== "tool" || part.state?.status !== "error") return undefined
  const sessionID = part.sessionID ?? event.properties?.sessionID
  if (typeof sessionID !== "string" || typeof part.callID !== "string" || typeof part.tool !== "string") return undefined
  return { sessionID, callID: part.callID, tool: part.tool, error: typeof part.state.error === "string" ? part.state.error : "" }
}

function mcpText(result: { content: unknown[] }): string {
  return result.content
    .flatMap((item) => {
      const entry = item as { type?: unknown; text?: unknown; resource?: { text?: unknown } }
      if (entry?.type === "text" && typeof entry.text === "string") return [entry.text]
      if (entry?.type === "resource" && typeof entry.resource?.text === "string") return [entry.resource.text]
      return []
    })
    .join("\n")
}

export interface SessionAnomaly {
  type: "AUDIT_BYPASS_RISK" | "MCP_TOOL_FAILURE" | "AUTH_CHALLENGE" | "RETRY_LOOP" | "INFERENCE_ERROR"
  severity: "critical" | "high" | "medium" | "low"
  tool?: string
  detail: string
  recommendation: string
}

export interface SessionRetrospective {
  sessionId: string
  workspaceDirectory?: string
  startTime: number
  endTime: number
  durationMs: number
  totalToolCalls: number
  toolsUsed: string[]
  anomalies: SessionAnomaly[]
  learnings: string[]
  telemetry?: {
    servedModel?: string
    provider?: string
    costUsd?: string
    latencyMs?: string
    correlationId?: string
  }
}

export interface DiagnosticLogEntry {
  timestamp: string
  type: "INFERENCE_REQUEST" | "ESCALATION" | "INFERENCE_RESPONSE" | "INFERENCE_ERROR" | "TOOL_EXECUTION" | "AUTH_EVENT" | "FALLBACK_TRIGGERED"
  sessionId?: string
  correlationId?: string
  details: Record<string, any>
  error?: string
}

export function redactSensitiveData(data: any): any {
  if (typeof data === "string") {
    const masked = data
      .replace(/Bearer\s+eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/gi, "Bearer [REDACTED_JWT]")
      // #26: capture the name, so the result reads `token: [REDACTED]` (the group was
      // non-capturing, so this wrote a literal "$1").
      .replace(/(key|token|secret|password|authorization)\s*[:=]\s*["']?[A-Za-z0-9-_]{8,}["']?/gi, "$1: [REDACTED]")
    return redactSecrets(masked)
  }
  if (!data || typeof data !== "object") return data
  if (Array.isArray(data)) return data.map(redactSensitiveData)
  const redacted: Record<string, any> = {}
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase()
    if (
      lowerKey.includes("token") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("password") ||
      lowerKey.includes("authorization") ||
      lowerKey.includes("apikey") ||
      lowerKey.includes("api_key")
    ) {
      redacted[key] = "[REDACTED]"
    } else if (typeof value === "object" && value !== null) {
      redacted[key] = redactSensitiveData(value)
    } else {
      redacted[key] = typeof value === "string" ? redactSensitiveData(value) : value
    }
  }
  return redacted
}

export function sanitizeJsonSchemaForOpenAI(schema: any): any {
  if (!schema || typeof schema !== "object") return schema
  if (Array.isArray(schema)) {
    return schema.map(sanitizeJsonSchemaForOpenAI)
  }
  const clean: Record<string, any> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === "propertyNames" || key === "$schema" || key === "$defs" || key === "definitions") continue
    if (typeof value === "object" && value !== null) {
      clean[key] = sanitizeJsonSchemaForOpenAI(value)
    } else {
      clean[key] = value
    }
  }
  return clean
}

const CORPORATE_AUDITED_DOMAINS = [
  "outlook.office.com",
  "outlook.live.com",
  "login.microsoftonline.com",
  "mail.google.com",
  "teams.microsoft.com",
  "sharepoint.com",
  "graph.microsoft.com",
]

class SessionObserverManager {
  private trajectories = new Map<string, ToolExecutionRecord[]>()
  private sessionStartTimes = new Map<string, number>()
  private latestRetrospectives: SessionRetrospective[] = []
  private diagnosticLogs: DiagnosticLogEntry[] = []
  private nativeTools = new Set<string>()

  public logDiagnostic(entry: DiagnosticLogEntry, workspaceDir?: string) {
    const safeEntry: DiagnosticLogEntry = {
      ...entry,
      details: redactSensitiveData(entry.details || {}),
    }
    this.diagnosticLogs.unshift(safeEntry)
    if (this.diagnosticLogs.length > 200) {
      this.diagnosticLogs.pop()
    }
    void this.persistDiagnosticLog(safeEntry, workspaceDir)
  }

  private async persistDiagnosticLog(entry: DiagnosticLogEntry, workspaceDir?: string) {
    const logLine = JSON.stringify(entry) + "\n"
    if (workspaceDir) {
      try {
        const logDir = path.join(workspaceDir, ".system_generated", "logs")
        await fs.mkdir(logDir, { recursive: true })
        const filePath = path.join(logDir, "diagnostics.log")
        await fs.appendFile(filePath, logLine, "utf8")
      } catch {}
    }
    // #83: a broken OPENCODE_DIAGNOSTICS_DIR (a file, no permission) used to drop the line
    // silently; fall back to the default log folder instead.
    const configured = diagnosticsLogDir()
    const fallback = defaultDiagnosticsLogDir()
    for (const dir of configured === fallback ? [configured] : [configured, fallback]) {
      if (!dir) continue
      try {
        await fs.mkdir(dir, { recursive: true })
        await fs.appendFile(path.join(dir, "diagnostics.log"), logLine, "utf8")
        return
      } catch {}
    }
  }

  public onToolBefore(sessionId: string, callId: string, tool: string, args: any) {
    if (!this.sessionStartTimes.has(sessionId)) {
      this.sessionStartTimes.set(sessionId, Date.now())
    }
    const records = this.trajectories.get(sessionId) ?? []
    records.push({
      callId,
      tool,
      args,
      startTime: Date.now(),
    })
    this.trajectories.set(sessionId, records)
  }

  /**
   * #18: opencode names MCP tools `<server>_<tool>` (`alterspective-rag_rag_search`), so a name
   * check alone misses them. Every native and plugin tool is announced through `tool.definition`
   * first; MCP tools never are.
   */
  public markNativeTool(toolId: string) {
    this.nativeTools.add(toolId)
  }

  private isMcpRecord(record: ToolExecutionRecord): boolean {
    if (record.mcp) return true
    if (record.tool.startsWith("mcp__") || record.tool.includes("mcp")) return true
    return this.nativeTools.size > 0 && !this.nativeTools.has(record.tool)
  }

  /**
   * #18: a failed tool never reaches `tool.execute.after` (an MCP error result is thrown by core),
   * so the failure is taken from the stored tool part instead (`message.part.updated`, status error).
   * Only a call this observer saw start is updated: a fork or compaction re-publishes old failed
   * parts, which must not be counted again. A call the user stopped, refused or blocked by a rule is
   * not a service failure (QA on #18).
   */
  public onToolFailed(sessionId: string, callId: string, tool: string, error: string) {
    const record = this.trajectories.get(sessionId)?.find((r) => r.callId === callId && r.tool === tool)
    if (!record) return
    record.endTime ??= Date.now()
    record.durationMs = record.endTime - record.startTime
    if (NOT_A_FAILURE.some((prefix) => error.startsWith(prefix)) || ABORTED.test(error)) return
    record.isError = true
    record.errorMessage = error.slice(0, 200)
  }

  public onToolAfter(sessionId: string, callId: string, tool: string, output: unknown) {
    // #18: an MCP result carries its text in `content` items, not in `output`.
    const mcp = isMcpResult(output)
    const text = typeof output === "string" ? output : mcp ? mcpText(output) : output == null ? "" : JSON.stringify(output) ?? ""
    const records = this.trajectories.get(sessionId) ?? []
    const record = records.find((r) => r.callId === callId)
    if (record && mcp) record.mcp = true
    // A real MCP error result is thrown by core and arrives through onToolFailed; the words in a
    // successful MCP result (a log or search tool's text) are data, not a failure (QA on #18).
    const isError = mcp
      ? output.isError === true
      : text.includes("Error:") ||
      text.includes("error:") ||
      text.includes("Failed to") ||
      text.includes("Unauthorized") ||
      text.includes("timed out")

    if (record) {
      record.endTime = Date.now()
      record.durationMs = record.endTime - record.startTime
      record.outputSnippet = text.slice(0, 300)
      record.isError = isError
      if (isError) {
        record.errorMessage = text.slice(0, 200)
      }
    }
  }

  public async finalizeSessionRetrospective(
    sessionId: string,
    workspaceDir?: string,
  ): Promise<SessionRetrospective | null> {
    // #55: sandboxes hold no Keystone credential, so they skip the retrospective file and POST. Read per call.
    if (truthy("OPENCODE_DISABLE_SESSION_RETROSPECTIVES")) {
      this.trajectories.delete(sessionId)
      this.sessionStartTimes.delete(sessionId)
      return null
    }

    const records = this.trajectories.get(sessionId) ?? []
    const startTime = this.sessionStartTimes.get(sessionId) ?? Date.now()
    const endTime = Date.now()
    // #209: a retrospective covers the calls since the last one. The records used to stay, so every
    // later idle reported the same failures again, and a long-running server kept every call's
    // arguments in memory for the life of the process.
    this.trajectories.delete(sessionId)
    this.sessionStartTimes.delete(sessionId)

    const anomalies: SessionAnomaly[] = []
    const learnings: string[] = []
    const toolsUsed = Array.from(new Set(records.map((r) => r.tool)))

    // 1. Check for Audit Bypass
    const playwrightCalls = records.filter((r) => r.tool.includes("playwright") || r.tool.includes("browser"))
    for (const pCall of playwrightCalls) {
      const url = pCall.args?.url || pCall.args?.Url || ""
      const isAuditedDomain = CORPORATE_AUDITED_DOMAINS.some((domain) => url.toLowerCase().includes(domain))
      if (isAuditedDomain) {
        anomalies.push({
          type: "AUDIT_BYPASS_RISK",
          severity: "high",
          tool: pCall.tool,
          detail: `Agent accessed corporate communication interface (${url}) via un-audited browser scraping.`,
          recommendation: `Ensure keystone-dynamic (ms365 MCP) is authenticated and used for email/calendar retrieval to maintain enterprise access governance.`,
        })
        learnings.push(
          `Bypass Detected: Direct browser automation was used on corporate domain '${url}'. Keystone MCP should be preferred and repaired if failing.`,
        )
      }
    }

    // 2. Check for MCP Tool Failures
    const mcpFailures = records.filter((r) => this.isMcpRecord(r) && r.isError)
    for (const failure of mcpFailures) {
      anomalies.push({
        type: "MCP_TOOL_FAILURE",
        severity: "medium",
        tool: failure.tool,
        detail: `MCP service returned an error during operation: ${failure.errorMessage ?? "Unknown error"}`,
        recommendation: `Verify MCP server connectivity, authentication status, and tool schema compatibility.`,
      })
      learnings.push(`MCP Error in ${failure.tool}: Verify authentication token and service health.`)
    }

    const serving = getLatestSynapseServing()
    const retro: SessionRetrospective = {
      sessionId,
      workspaceDirectory: workspaceDir,
      startTime,
      endTime,
      durationMs: Math.max(0, endTime - startTime),
      totalToolCalls: records.length,
      toolsUsed,
      anomalies,
      learnings:
        learnings.length > 0
          ? learnings
          : ["Session executed normally with all tool calls conforming to Alterspective operating standards."],
      telemetry: serving
        ? {
            servedModel: serving.model,
            provider: serving.provider,
            costUsd: serving.costUsd,
            latencyMs: serving.latencyMs,
            correlationId: serving.correlationId,
          }
        : undefined,
    }

    this.latestRetrospectives.unshift(retro)
    if (this.latestRetrospectives.length > 50) {
      this.latestRetrospectives.pop()
    }

    // Save locally
    if (workspaceDir) {
      try {
        const retroDir = path.join(workspaceDir, ".system_generated", "retrospectives")
        await fs.mkdir(retroDir, { recursive: true })
        const filePath = path.join(retroDir, `retro-${sessionId}-${Date.now()}.json`)
        await fs.writeFile(filePath, JSON.stringify(retro, null, 2), "utf8")
      } catch {}
    }

    // Async telemetry dispatch to Keystone / CAS audit endpoint (non-blocking)
    void this.dispatchAuditTelemetry(retro)

    return retro
  }

  private async dispatchAuditTelemetry(retro: SessionRetrospective) {
    try {
      await fetch("https://identity.alterspective.com.au/api/audit/session-retrospective", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(retro),
      })
    } catch {}
  }

  /**
   * Store a rule. With a `workspaceDir` it is written to BOTH stores, by design (#38): the global
   * copy is what makes `synapse_record_learning` keep its promise that the rule guides "all
   * future sessions", in any project; the project copy (`.system_generated/logs`, not committed)
   * keeps it with that workspace. So a rule recorded in a project is live machine-wide, and a
   * `forgetLearning` from the same workspace removes both copies. Without a `workspaceDir` only
   * the global store is written. Automatic rules (buddy review findings) are mirrored too, which
   * can carry one project's text into every project's prompt: an owner decision, #211. A store
   * that cannot be read is left alone, never overwritten. `savedTo` names the stores actually
   * written, so a caller never reports a rule as saved when it was not.
   */
  public async recordLearning(
    learning: Omit<SessionLearning, "id" | "timestamp">,
    workspaceDir?: string,
  ): Promise<SessionLearning & { savedTo: Array<"global" | "project"> }> {
    const normalizedText = learning.lesson.trim().toLowerCase()
    const paths = learningStorePaths(workspaceDir)
    const files = [paths.global, paths.project].filter((file): file is string => Boolean(file))
    const entry: SessionLearning = {
      id: `learn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...learning,
    }
    let stored = entry
    const savedTo: Array<"global" | "project"> = []
    await this.mutate(async () => {
      for (const file of files) {
        const scope: "global" | "project" = file === paths.project ? "project" : "global"
        try {
          await fs.mkdir(path.dirname(file), { recursive: true })
          // #38: a store we cannot read is left alone. Writing one row over it would drop its
          // other rules and the tombstones that keep forgotten rules forgotten.
          const read = await readRuleStore(file)
          if (read === "unreadable") continue
          const existing: SessionLearning[] = read ?? []
          const found = existing.find((e) => e.lesson.trim().toLowerCase() === normalizedText)
          if (found) {
            // Re-recording refreshes recency AND moves the rule to the front, so it
            // re-enters the injection window; it never duplicates. It also clears any
            // tombstone, which is how a forgotten rule is restored.
            found.timestamp = new Date().toISOString()
            found.scope = scope
            found.deletedAt = undefined
            found.deletedBy = undefined
            stored = found
            await writeJsonAtomic(file, trimRules([found, ...existing.filter((e) => e !== found)]))
            savedTo.push(scope)
            continue
          }
          await writeJsonAtomic(file, trimRules([{ ...entry, scope }, ...existing]))
          stored = { ...entry, scope }
          savedTo.push(scope)
        } catch {}
      }
    })
    return { ...stored, savedTo }
  }

  /**
   * The rules actually selected for injection, in the same order the prompt
   * builder uses. Shared so the listed `injected` flag cannot drift from reality.
   */
  private async selectInjected(limit: number, workspaceDir?: string): Promise<SessionLearning[]> {
    // Always read from disk, from the right stores for THIS workspace. One process
    // can serve several projects, so no cached list may be reused across them.
    return this.mutate(async () => {
      // #212: the same row check as a forget, so a malformed row cannot throw in isLive.
      const read = async (file?: string): Promise<SessionLearning[]> => {
        const rows = file ? await readRuleStore(file) : undefined
        return Array.isArray(rows) ? rows : []
      }
      const paths = learningStorePaths(workspaceDir)
      // Project rules first: a committed, reviewed repo rule outranks an ad-hoc
      // global note (AIMETH-008 - shared repo facts win). One entry per rule text.
      const seen = new Set<string>()
      const merged: SessionLearning[] = []
      for (const rule of [...(await read(paths.project)), ...(await read(paths.global))].filter(isLive)) {
        const key = learningKey(rule)
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(rule)
      }
      return merged.slice(0, limit)
    })
  }

  public async getRecentLearnings(limit = 5, workspaceDir?: string): Promise<SessionLearning[]> {
    return this.selectInjected(limit, workspaceDir)
  }

  private mutation: Promise<unknown> = Promise.resolve()

  /** Serialise file mutations so a record and a forget cannot interleave on one file. */
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutation.then(fn, fn)
    this.mutation = run.catch(() => {})
    return run
  }

  /**
   * Every persisted rule, tagged with which store it lives in (`global` = whole
   * machine, `project` = this repo) and whether it is actually injected into a
   * session's system prompt. This is the honest answer to "what rules is the
   * agent using?" - a rule outside the injection window is shown as stored.
   */
  public async listLearnings(
    workspaceDir?: string,
  ): Promise<Array<SessionLearning & { origin: "global" | "project"; injected: boolean }>> {
    // #212: the same row check as a forget, so a malformed row cannot throw in isLive.
    const read = async (file?: string): Promise<SessionLearning[]> => {
      const rows = file ? await readRuleStore(file) : undefined
      return Array.isArray(rows) ? rows : []
    }
    const paths = learningStorePaths(workspaceDir)
    const global = (await read(paths.global)).filter(isLive)
    const project = (await read(paths.project)).filter(isLive)
    const globalKeys = new Set(global.map(learningKey))
    const merged = [
      ...global.map((l) => ({ ...l, origin: "global" as const })),
      ...project
        .filter((l) => !globalKeys.has(learningKey(l)))
        .map((l) => ({ ...l, origin: "project" as const })),
    ].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    const injectedKeys = new Set((await this.selectInjected(INJECTED_LEARNINGS_LIMIT, workspaceDir)).map(learningKey))
    return merged.map((l) => ({ ...l, injected: injectedKeys.has(learningKey(l)) }))
  }

  /**
   * #217: the rule stores that exist but cannot be read. List and inject read such a store as
   * empty, so its rules silently stop applying; synapse_list_rules names it instead.
   */
  public async unreadableRuleStores(workspaceDir?: string): Promise<Array<"global" | "project">> {
    const paths = learningStorePaths(workspaceDir)
    const out: Array<"global" | "project"> = []
    if (paths.project && (await readRuleStore(paths.project)) === "unreadable") out.push("project")
    if (paths.global && (await readRuleStore(paths.global)) === "unreadable") out.push("global")
    return out
  }

  /**
   * Forget rules whose text matches (case-insensitive substring): mark them deleted
   * (tombstone) in both persisted stores. Returns the number of distinct rules newly
   * forgotten; a rule present in both stores is counted once. A rule recorded in a project
   * lives in both stores (see `recordLearning`), so one forget from that workspace removes both
   * copies; from another workspace only the global copy is reached. If any
   * store cannot be read, nothing is changed and 0 is returned (#38); if a write fails, the stores
   * already written are put back where possible and 0 is returned (#212).
   */
  public async forgetLearning(lessonText: string, workspaceDir?: string): Promise<number> {
    return (await this.forgetLearningResult(lessonText, workspaceDir)).forgotten
  }

  /**
   * `forgetLearning` with the reason a forget was refused (#212): `unreadable` (a store could not
   * be read; nothing was changed) or `write_failed` (a write failed; stores already written were
   * put back, best effort: `restored` is false when that put-back failed too, so a rule may be
   * half forgotten). A refused forget always reports 0 forgotten.
   */
  public async forgetLearningResult(
    lessonText: string,
    workspaceDir?: string,
  ): Promise<{ forgotten: number; refused?: "unreadable" | "write_failed"; restored?: boolean }> {
    const needle = lessonText.trim().toLowerCase()
    if (!needle) return { forgotten: 0 }
    const matches = (l: SessionLearning) => String(l.lesson ?? "").toLowerCase().includes(needle)
    const paths = learningStorePaths(workspaceDir)
    const files = [paths.global, paths.project].filter((file): file is string => Boolean(file))
    // One mutation for both stores, so a record cannot interleave between them.
    return this.mutate(async () => {
      // #38: read and check every store before writing any. If a store cannot be read, we
      // cannot claim its copy is gone, so we report nothing AND change nothing: a refused
      // forget used to tombstone the global copy before it found the project store unreadable.
      const stores: Array<{ file: string; rows: SessionLearning[] }> = []
      for (const file of files) {
        const read = await readRuleStore(file)
        if (read === "unreadable") return { forgotten: 0, refused: "unreadable" as const }
        if (read) stores.push({ file, rows: read })
      }
      const forgotten = new Set<string>()
      const written: Array<{ file: string; before: SessionLearning[] }> = []
      for (const store of stores) {
        const before = structuredClone(store.rows)
        const keys = markForgotten(store.rows, matches)
        if (keys.size === 0) continue
        try {
          await writeJsonAtomic(store.file, trimRules(store.rows))
        } catch {
          // #212: one store written and the next not would leave a rule half forgotten; put the
          // written stores back (best effort) so a refused forget changes nothing here either.
          let restored = true
          for (const done of written)
            await writeJsonAtomic(done.file, done.before).catch(() => {
              restored = false
            })
          return { forgotten: 0, refused: "write_failed" as const, restored }
        }
        written.push({ file: store.file, before })
        for (const key of keys) forgotten.add(key)
      }
      return { forgotten: forgotten.size }
    })
  }

  public getLatestRetrospectives(): SessionRetrospective[] {
    return this.latestRetrospectives
  }

  public getDiagnosticLogs(): DiagnosticLogEntry[] {
    return this.diagnosticLogs
  }
}

/** How many of the most-recent rules are injected into a session system prompt. */
export const INJECTED_LEARNINGS_LIMIT = 5

/**
 * Where the machine-wide diagnostics.log goes: OPENCODE_DIAGNOSTICS_DIR, else
 * <home>/.local/share/opencode/log. OPENCODE_TEST_HOME wins over the real home, as in core's
 * Global.Path.home, so a test run never writes to the person's real log (#80 follow-up).
 */
export function diagnosticsLogDir(): string | undefined {
  return process.env.OPENCODE_DIAGNOSTICS_DIR || defaultDiagnosticsLogDir()
}

/** <home>/.local/share/opencode/log: where diagnostics.log goes without OPENCODE_DIAGNOSTICS_DIR. */
export function defaultDiagnosticsLogDir(): string | undefined {
  const home = observerHome()
  return home ? path.join(home, ".local", "share", "opencode", "log") : undefined
}

/** The home the observer writes under: OPENCODE_TEST_HOME first, as in core's Global.Path.home. */
function observerHome(): string {
  return process.env.OPENCODE_TEST_HOME || process.env.USERPROFILE || process.env.HOME || ""
}

/**
 * The two on-disk rule stores: global (whole machine) and this project. #83: the global store
 * honours OPENCODE_TEST_HOME too, so a test never writes to the person's real learnings.json.
 */
export function learningStorePaths(workspaceDir?: string): { global?: string; project?: string } {
  const homeDir = observerHome()
  return {
    global: homeDir ? path.join(homeDir, ".local", "share", "opencode", "learnings.json") : undefined,
    project: workspaceDir ? path.join(workspaceDir, ".system_generated", "logs", "learnings.json") : undefined,
  }
}

const learningKey = (l: SessionLearning) => String(l.lesson ?? "").trim().toLowerCase()

/** A rule is live unless it carries a tombstone. */
const isLive = (l: SessionLearning) => !l.deletedAt

/**
 * One rule store's rows. `undefined`: the store does not exist, which is a real absence.
 * `"unreadable"`: any other read error, bad JSON, JSON that is not an array, or a row that is not
 * a rule (an object with a string `lesson`); we cannot know what the store holds.
 */
async function readRuleStore(file: string): Promise<SessionLearning[] | undefined | "unreadable"> {
  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined
    return code === "ENOENT" ? undefined : "unreadable"
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return "unreadable"
    // A hand-edited or cut-off store can hold `[null]` or `[42]`; such a row would throw half
    // way through a forget, after another store was already written (CodeRabbit on #38).
    const valid = parsed.every(
      (row) => !!row && typeof row === "object" && typeof (row as { lesson?: unknown }).lesson === "string",
    )
    return valid ? (parsed as SessionLearning[]) : "unreadable"
  } catch {
    return "unreadable"
  }
}

/**
 * Tombstone the matching live rows in place and return their keys. The rows are kept so a later
 * merge or sync cannot resurrect them.
 */
function markForgotten(rows: SessionLearning[], matches: (l: SessionLearning) => boolean): Set<string> {
  const keys = new Set<string>()
  for (const row of rows) {
    if (!isLive(row) || !matches(row)) continue
    row.deletedAt = new Date().toISOString()
    row.deletedBy = process.env.USERNAME || process.env.USER || "local"
    keys.add(learningKey(row))
  }
  return keys
}

const MAX_LIVE_RULES = 100
const MAX_TOMBSTONES = 100

/**
 * Bound file size without evicting tombstones: a dropped tombstone would let a
 * later merge resurrect the rule it records as deleted.
 */
function trimRules(rows: SessionLearning[]): SessionLearning[] {
  return [
    ...rows.filter(isLive).slice(0, MAX_LIVE_RULES),
    ...rows.filter((r) => !isLive(r)).slice(0, MAX_TOMBSTONES),
  ]
}

/** Write JSON via a temp file + rename so a reader never sees a half-written file. */
/** Write a rule store through a temp file and a rename. Exported for tests (#217). */
export async function writeJsonAtomic(file: string, rows: SessionLearning[]): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 7)}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf8")
    await fs.rename(tmp, file)
  } catch (error) {
    // #217: a failed rename (Windows EPERM/EBUSY) used to leave learnings.json.*.tmp behind.
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

export interface SessionLearning {
  id: string
  timestamp: string
  lesson: string
  context?: string
  source: "user_feedback" | "buddy_review" | "auto_correction" | "session_retro"
  /** Which store this row belongs to. */
  scope?: "global" | "project"
  /** Tombstone: set when the rule is forgotten, so a later merge cannot resurrect it. */
  deletedAt?: string
  deletedBy?: string
}

export const sessionObserver = new SessionObserverManager()


