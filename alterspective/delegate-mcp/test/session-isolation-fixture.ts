import { createHash } from "node:crypto"
import type { MemoryProtection } from "../src/supervisor/api-isolation.ts"

export const MEMORY_OK: MemoryProtection = { ok: true, ptraceScope: 1, memDenied: true, ptraceDenied: true, vmReadDenied: true, coreDisabled: true, debuggerDisabled: true, verifierOnly: true, codeLoadingRestricted: true, serverCommand: true, listeningPorts: [4096], problems: [] }
export const apiEnv = (password: string) => [
  `OPENCODE_SERVER_PASSWORD_SHA256=${createHash("sha256").update(password).digest("hex")}`,
  "OPENCODE_DISABLE_REMOTE_CONFIG=1", "OPENCODE_DISABLE_EXTERNAL_PROVIDERS=1",
]
