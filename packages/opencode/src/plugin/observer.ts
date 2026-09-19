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

  public onToolAfter(sessionId: string, callId: string, tool: string, output: string) {
    const records = this.trajectories.get(sessionId) ?? []
    const record = records.find((r) => r.callId === callId)
    const isError =
      output.includes("Error:") ||
      output.includes("error:") ||
      output.includes("Failed to") ||
      output.includes("Unauthorized") ||
      output.includes("timed out")

    if (record) {
      record.endTime = Date.now()
      record.durationMs = record.endTime - record.startTime
      record.outputSnippet = output.slice(0, 300)
      record.isError = isError
      if (isError) {
        record.errorMessage = output.slice(0, 200)
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

    // Persist to central learnings.json with disk-level deduplication
    try {
      const homeDir = process.env.USERPROFILE || process.env.HOME || ""
      if (homeDir) {
        const centralDir = path.join(homeDir, ".local", "share", "opencode")
        await fs.mkdir(centralDir, { recursive: true })
        const centralFile = path.join(centralDir, "learnings.json")
        let existing: SessionLearning[] = []
        try {
          existing = JSON.parse(await fs.readFile(centralFile, "utf8"))
        } catch {}
        if (!existing.some((e) => e.lesson.trim().toLowerCase() === normalizedText)) {
          existing.unshift(entry)
          await fs.writeFile(centralFile, JSON.stringify(existing.slice(0, 100), null, 2), "utf8")
        }
      }
    } catch {}

    // Persist to workspace if available with deduplication
    if (workspaceDir) {
      try {
        const wsDir = path.join(workspaceDir, ".system_generated", "logs")
        await fs.mkdir(wsDir, { recursive: true })
        const wsFile = path.join(wsDir, "learnings.json")
        let existing: SessionLearning[] = []
        try {
          existing = JSON.parse(await fs.readFile(wsFile, "utf8"))
        } catch {}
        if (!existing.some((e) => e.lesson.trim().toLowerCase() === normalizedText)) {
          existing.unshift(entry)
          await fs.writeFile(wsFile, JSON.stringify(existing.slice(0, 100), null, 2), "utf8")
        }
      } catch {}
    }
    return entry
  }

  public async getRecentLearnings(limit = 5): Promise<SessionLearning[]> {
    if (this.sessionLearnings.length > 0) {
      return this.sessionLearnings.slice(0, limit)
    }
    try {
      const homeDir = process.env.USERPROFILE || process.env.HOME || ""
      if (homeDir) {
        const centralFile = path.join(homeDir, ".local", "share", "opencode", "learnings.json")
        const content = JSON.parse(await fs.readFile(centralFile, "utf8"))
        if (Array.isArray(content)) {
          this.sessionLearnings = content
          return this.sessionLearnings.slice(0, limit)
        }
      }
    } catch {}
    return []
  }

  public getLatestRetrospectives(): SessionRetrospective[] {
    return this.latestRetrospectives
  }

  public getDiagnosticLogs(): DiagnosticLogEntry[] {
    return this.diagnosticLogs
  }
}

export interface SessionLearning {
  id: string
  timestamp: string
  lesson: string
  context?: string
  source: "user_feedback" | "buddy_review" | "auto_correction" | "session_retro"
}

export const sessionObserver = new SessionObserverManager()

