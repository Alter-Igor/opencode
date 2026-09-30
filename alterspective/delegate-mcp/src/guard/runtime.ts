// MOD-02 runtime guard (technical-design §3.5): before each send, GET /mcp for the session
// directory and require every listed entry to be ks-*. The fork patch has already refused any
// entry whose URL fails the allowlist at create/startAuth, so the names are what remains to check.
// Anything the bridge cannot read or understand is policy_unverified (fails closed).
import type { Verdict } from "../shared/contracts.ts"
import type { OpencodeApi } from "../shared/opencode-api.ts"
import { KS_NAME } from "./entries.ts"

const unverified = (reason: string): Verdict => ({ ok: false, code: "policy_unverified", reason })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readMcp(api: OpencodeApi, directory: string): Promise<{ status: number; data: unknown } | string> {
  try {
    return await api.call<unknown>({ path: "/mcp", directory })
  } catch (error) {
    return `could not read MCP status: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Judge a GET /mcp body: violations (non-ks names) win over malformed values. */
export function judgeMcpStatus(data: unknown): Verdict {
  if (!isRecord(data)) return unverified("MCP status is not a JSON object")
  const names = Object.keys(data)
  const bad = names.filter((name) => !KS_NAME.test(name))
  if (bad.length > 0) {
    return { ok: false, code: "policy_violation", reason: `non-Keystone MCP entr${bad.length === 1 ? "y" : "ies"} present: ${bad.join(", ")}` }
  }
  const malformed = names.filter((name) => {
    const value = data[name]
    return !isRecord(value) || typeof value.status !== "string"
  })
  if (malformed.length > 0) return unverified(`MCP status for ${malformed.join(", ")} is malformed`)
  return { ok: true }
}

export async function checkRuntime(api: OpencodeApi, directory: string): Promise<Verdict> {
  // Always scope to the session directory (review M5): an unscoped read shows another instance.
  if (!directory) return unverified("no session directory to check")
  const result = await readMcp(api, directory)
  if (typeof result === "string") return unverified(result)
  if (result.status < 200 || result.status >= 300) return unverified(`GET /mcp returned HTTP ${result.status}`)
  return judgeMcpStatus(result.data)
}
