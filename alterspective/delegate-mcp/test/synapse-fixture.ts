// WS2 (#48): a ToolContext.synapse stand-in. Signed in and loaded in front unless told otherwise.
import type { SynapseReport } from "../src/synapse/index.ts"
import type { ToolContext } from "../src/tools/context.ts"

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
/** A compact JWT with these claims and a dummy signature (never verified here). */
export const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.${"s".repeat(43)}`

export const SIGNED_IN: SynapseReport = {
  state: "signed_in",
  user: "owner@example.test",
  actor: "service:opencode",
  expiresAt: "2026-10-01T10:00:00.000Z",
  refreshAt: "2026-10-01T09:48:00.000Z",
  refreshTokenStored: true,
  store: "memory",
  hostFile: { shapeOk: true, hasToken: true },
  pendingSave: false,
  loadedSinceWrite: true,
  live: { shapeOk: true, hasToken: true, matchesHost: true, routesOk: true },
  ok: true,
}

export function fakeSynapse(report: SynapseReport = SIGNED_IN): ToolContext["synapse"] {
  return {
    status: async () => report,
    signIn: async () => ({ reload: "reloaded", user: report.user, expiresAt: Date.parse(report.expiresAt ?? "2026-10-01T10:00:00.000Z") }),
    refresh: async () => ({ outcome: "fresh" }),
  }
}
