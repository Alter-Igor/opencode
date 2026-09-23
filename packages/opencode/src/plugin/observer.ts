import * as fs from "node:fs/promises"
import * as path from "node:path"
import { getLatestSynapseServing } from "./synapse"

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
  }
}

export interface DiagnosticLogEntry {
  timestamp: string
  type: "INFERENCE_REQUEST" | "ESCALATION" | "INFERENCE_RESPONSE" | "INFERENCE_ERROR" | "TOOL_EXECUTION" | "AUTH_EVENT" | "FALLBACK_TRIGGERED"
  sessionId?: string
  details: Record<string, any>
  error?: string
}

export function redactSensitiveData(data: any): any {
  if (typeof data === "string") {
    return data
      .replace(/Bearer\s+eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/gi, "Bearer [REDACTED_JWT]")
      .replace(/(?:key|token|secret|password|authorization)\s*[:=]\s*["']?[A-Za-z0-9-_]{8,}["']?/gi, "$1: [REDACTED]")
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
    try {
      const homeDir = process.env.USERPROFILE || process.env.HOME || ""
      if (homeDir) {
        const centralLogDir = path.join(homeDir, ".local", "share", "opencode", "log")
        await fs.mkdir(centralLogDir, { recursive: true })
        await fs.appendFile(path.join(centralLogDir, "diagnostics.log"), logLine, "utf8")
      }
    } catch {}
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

  public onToolAfter(sessionId: string, callId: string, tool: string, output: unknown) {
    const text = typeof output === "string" ? output : output == null ? "" : JSON.stringify(output) ?? ""
    const records = this.trajectories.get(sessionId) ?? []
    const record = records.find((r) => r.callId === callId)
    const isError =
      text.includes("Error:") ||
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
    const records = this.trajectories.get(sessionId) ?? []
    const startTime = this.sessionStartTimes.get(sessionId) ?? Date.now()
    const endTime = Date.now()

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
    const mcpFailures = records.filter((r) => (r.tool.startsWith("mcp__") || r.tool.includes("mcp")) && r.isError)
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

  private sessionLearnings: SessionLearning[] = []

  public async recordLearning(
    learning: Omit<SessionLearning, "id" | "timestamp">,
    workspaceDir?: string,
  ): Promise<SessionLearning> {
    const normalizedText = learning.lesson.trim().toLowerCase()
    const existingIndex = this.sessionLearnings.findIndex(
      (l) => l.lesson.trim().toLowerCase() === normalizedText,
    )
    if (existingIndex !== -1) {
      // Update existing entry timestamp and return without duplicating
      const existing = this.sessionLearnings[existingIndex]
      existing.timestamp = new Date().toISOString()
      return existing
    }

    const entry: SessionLearning = {
      id: `learn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...learning,
    }
    this.sessionLearnings.unshift(entry)
    if (this.sessionLearnings.length > 100) this.sessionLearnings.pop()

    // Persist to the central and workspace stores, serialised against forgetLearning.
    const homeDir = process.env.USERPROFILE || process.env.HOME || ""
    const files = [
      homeDir ? path.join(homeDir, ".local", "share", "opencode", "learnings.json") : undefined,
      workspaceDir ? path.join(workspaceDir, ".system_generated", "logs", "learnings.json") : undefined,
    ].filter((file): file is string => Boolean(file))
    await this.mutate(async () => {
      for (const file of files) {
        try {
          await fs.mkdir(path.dirname(file), { recursive: true })
          let existing: SessionLearning[] = []
          try {
            const parsed = JSON.parse(await fs.readFile(file, "utf8"))
            if (Array.isArray(parsed)) existing = parsed
          } catch {}
          if (!existing.some((e) => e.lesson.trim().toLowerCase() === normalizedText)) {
            await writeJsonAtomic(file, [entry, ...existing].slice(0, 100))
          }
        } catch {}
      }
    })
    return entry
  }

  /**
   * The rules actually selected for injection, in the same order the prompt
   * builder uses. Shared so the listed `injected` flag cannot drift from reality.
   */
  private async selectInjected(limit: number): Promise<SessionLearning[]> {
    if (this.sessionLearnings.length > 0) {
      return this.sessionLearnings.slice(0, limit)
    }
    // Read through the mutation queue: a read that starts while a forget is still
    // writing must not reload the store it is about to forget from.
    const loaded = await this.mutate(async () => {
      try {
        const homeDir = process.env.USERPROFILE || process.env.HOME || ""
        if (!homeDir) return [] as SessionLearning[]
        const centralFile = path.join(homeDir, ".local", "share", "opencode", "learnings.json")
        const content = JSON.parse(await fs.readFile(centralFile, "utf8"))
        return Array.isArray(content) ? (content as SessionLearning[]) : []
      } catch {
        return [] as SessionLearning[]
      }
    })
    if (loaded.length > 0) this.sessionLearnings = loaded
    return loaded.slice(0, limit)
  }

  public async getRecentLearnings(limit = 5): Promise<SessionLearning[]> {
    return this.selectInjected(limit)
  }

  private mutation: Promise<unknown> = Promise.resolve()

  /** Serialise file mutations so a record and a forget cannot interleave on one file. */
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutation.then(fn, fn)
    this.mutation = run.catch(() => {})
    return run
  }

  /**
   * Every persisted rule, with where it was found and whether it is one of the
   * most-recent rules actually injected into a session's system prompt. This is
   * the honest answer to "what rules is the agent using?" - recorded rules that
   * fall outside the injection window are shown as `stored`, not `injected`.
   */
  public async listLearnings(
    workspaceDir?: string,
  ): Promise<Array<SessionLearning & { origin: "central" | "workspace"; injected: boolean }>> {
    const read = async (file: string): Promise<SessionLearning[]> => {
      try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8"))
        return Array.isArray(parsed) ? (parsed as SessionLearning[]) : []
      } catch {
        return []
      }
    }
    const homeDir = process.env.USERPROFILE || process.env.HOME || ""
    const central = homeDir
      ? await read(path.join(homeDir, ".local", "share", "opencode", "learnings.json"))
      : []
    const workspace = workspaceDir
      ? await read(path.join(workspaceDir, ".system_generated", "logs", "learnings.json"))
      : []
    const centralKeys = new Set(central.map((l) => l.lesson.trim().toLowerCase()))
    const merged = [
      ...central.map((l) => ({ ...l, origin: "central" as const })),
      ...workspace
        .filter((l) => !centralKeys.has(l.lesson.trim().toLowerCase()))
        .map((l) => ({ ...l, origin: "workspace" as const })),
    ].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    const injectedKeys = new Set((await this.selectInjected(INJECTED_LEARNINGS_LIMIT)).map(learningKey))
    return merged.map((l) => ({ ...l, injected: injectedKeys.has(learningKey(l)) }))
  }

  /**
   * Remove rules whose text matches (case-insensitive substring) from memory and
   * from both persisted stores. Returns the number of distinct rules removed; a
   * rule present in both stores is counted once.
   */
  public async forgetLearning(lessonText: string, workspaceDir?: string): Promise<number> {
    const needle = lessonText.trim().toLowerCase()
    if (!needle) return 0
    const matches = (l: SessionLearning) => String(l.lesson ?? "").toLowerCase().includes(needle)
    this.sessionLearnings = this.sessionLearnings.filter((l) => !matches(l))
    const homeDir = process.env.USERPROFILE || process.env.HOME || ""
    const files = [
      homeDir ? path.join(homeDir, ".local", "share", "opencode", "learnings.json") : undefined,
      workspaceDir ? path.join(workspaceDir, ".system_generated", "logs", "learnings.json") : undefined,
    ].filter((file): file is string => Boolean(file))
    const removed = new Set<string>()
    for (const file of files) {
      for (const key of await this.dropRules(file, matches)) removed.add(key)
    }
    return removed.size
  }

  /**
   * Remove matching rules from one store atomically and count them. A removal is
   * only reported when the write landed; a failed write returns nothing and the
   * file is left untouched.
   */
  private dropRules(file: string, matches: (l: SessionLearning) => boolean): Promise<Set<string>> {
    return this.mutate(async () => {
      const found = new Set<string>()
      try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8"))
        if (!Array.isArray(parsed)) return found
        const kept: SessionLearning[] = []
        for (const row of parsed as SessionLearning[]) {
          if (matches(row)) {
            found.add(String(row.lesson ?? "").trim().toLowerCase())
            continue
          }
          kept.push(row)
        }
        if (found.size === 0) return found
        await writeJsonAtomic(file, kept.slice(0, 100))
      } catch {
        return new Set<string>()
      }
      return found
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

const learningKey = (l: SessionLearning) => String(l.lesson ?? "").trim().toLowerCase()

/** Write JSON via a temp file + rename so a reader never sees a half-written file. */
async function writeJsonAtomic(file: string, rows: SessionLearning[]): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 7)}.tmp`
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2), "utf8")
  await fs.rename(tmp, file)
}

export interface SessionLearning {
  id: string
  timestamp: string
  lesson: string
  context?: string
  source: "user_feedback" | "buddy_review" | "auto_correction" | "session_retro"
}

export const sessionObserver = new SessionObserverManager()


