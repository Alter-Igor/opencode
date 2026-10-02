// #67 step 4: oc_doctor's `keystoneAuth` section. With host-held Keystone tokens
// (OCD_KEYSTONE_HOST_AUTH=1, ctx.keystone set) it joins three views of each chosen connection:
// the host token state (keystone-auth/report.ts), the include front's running worker attested
// (front-generation.ts, via the live check) and the box's MCP sign-in store, which must be empty.
// It also compares the ids front lists with the chosen ids (deferred from the WS-A2 review).
// States, times and booleans only: never a token.
import type { KsStatus } from "../keystone-auth/index.ts"
import type { LiveChecks } from "../supervisor/live.ts"
import type { ToolContext } from "./context.ts"
import type { KeystoneReport } from "./keystone-report.ts"

/** One chosen connection's host-held token, by state only (never a value). */
export type KeystoneAuthConnection = {
  connection: string
  state: KsStatus["state"]
  signedIn: boolean
  needsSignIn: boolean
  expiresAt?: string
  refreshAt?: string
  /** What the host last gave front (a bearer or an empty credential). */
  credential?: "published" | "empty"
  /** The include front's running worker attested for this id: strict shape, carries a token. null: front lists none. */
  published: { shape: boolean; token: boolean } | null
}

/** `enabled: false` while OCD_KEYSTONE_HOST_AUTH is off (the box signs in itself). */
export type KeystoneAuthReport =
  | { enabled: false }
  | { enabled: true; ok: false; unavailable: string }
  | {
      enabled: true
      ok: boolean
      connections: KeystoneAuthConnection[]
      /** Ids of the Keystone includes front's running worker attested; null when it attested none. */
      frontIds: string[] | null
      missingInFront: string[]
      extraInFront: string[]
      /** The box's MCP sign-in store holds nothing (null: not checked, the sandbox is not running). */
      boxStoreEmpty: boolean | null
      problems: string[]
    }

const NEEDS_SIGN_IN: ReadonlySet<KsStatus["state"]> = new Set<KsStatus["state"]>(["needs_sign_in", "signed_out"])

function connectionOf(status: KsStatus, front: LiveChecks["front"]["keystone"]): KeystoneAuthConnection {
  const attested = front?.find((entry) => entry.id === status.connection)
  return {
    connection: status.connection,
    state: status.state,
    signedIn: status.state === "signed_in",
    needsSignIn: NEEDS_SIGN_IN.has(status.state),
    ...(status.expiresAt ? { expiresAt: status.expiresAt } : {}),
    ...(status.refreshAt ? { refreshAt: status.refreshAt } : {}),
    ...(status.credential ? { credential: status.credential } : {}),
    published: attested ? { shape: attested.shape, token: attested.token } : null,
  }
}

function problemsOf(connections: KeystoneAuthConnection[], missing: string[], extra: string[], boxStoreEmpty: boolean | null): string[] {
  const problems: string[] = []
  for (const c of connections) {
    if (c.needsSignIn) problems.push(`${c.connection} needs sign-in (run oc_login {server: "ks-${c.connection}"})`)
    else if (!c.signedIn) problems.push(`${c.connection} is ${c.state}`)
    if (c.published && !(c.published.shape && c.published.token)) problems.push(`front's loaded include for ${c.connection} has no token or not the strict shape`)
  }
  if (missing.length) problems.push(`front does not list the chosen connection(s) ${missing.join(", ")} (restart the sandbox if it lasts)`)
  if (extra.length) problems.push(`front lists connection(s) outside the chosen set: ${extra.join(", ")}`)
  if (boxStoreEmpty === false) problems.push("the box's MCP sign-in store is NOT empty (it must hold nothing; restart the sandbox to prune it)")
  if (boxStoreEmpty === null) problems.push("the box's sign-in store was not checked (the sandbox is not running)")
  return problems
}

/**
 * The host-held Keystone tokens of the chosen connections, against what front loaded and the box store.
 *
 * @param ctx tool context (ctx.keystone is set only with OCD_KEYSTONE_HOST_AUTH=1)
 * @param keystone the chosen set report (keystone-report.ts)
 * @param live the live checks, undefined when the sandbox is not running
 * @returns the report; `ok` is true only when every chosen connection is signed in, front loaded a
 *   token for each and lists exactly the chosen ids, and the box store is empty
 * @throws never (a failing status read is an `unavailable` report)
 * @example const report = await keystoneAuthReport(ctx, keystoneReport(ctx.config), live)
 */
export async function keystoneAuthReport(ctx: Pick<ToolContext, "keystone">, keystone: KeystoneReport, live: LiveChecks | undefined): Promise<KeystoneAuthReport> {
  if (!ctx.keystone) return { enabled: false }
  if ("unavailable" in keystone) return { enabled: true, ok: false, unavailable: keystone.unavailable }
  const chosen = keystone.connections
  let statuses: KsStatus[]
  try {
    statuses = await ctx.keystone.status(chosen)
  } catch (error) {
    return { enabled: true, ok: false, unavailable: error instanceof Error ? error.message.slice(0, 300) : "the host token states could not be read" }
  }
  const front = live?.front.keystone
  const frontIds = front ? front.map((entry) => entry.id) : null
  const missingInFront = chosen.filter((id) => !(frontIds ?? []).includes(id))
  const extraInFront = (frontIds ?? []).filter((id) => !chosen.includes(id))
  const boxStoreEmpty = live ? live.signIns.ok && live.signIns.names.length === 0 && live.signIns.unrecognised === 0 : null
  const connections = statuses.map((status) => connectionOf(status, front))
  const problems = problemsOf(connections, missingInFront, extraInFront, boxStoreEmpty)
  const complete = connections.length === chosen.length && connections.every((c) => c.signedIn && c.published?.shape === true && c.published.token)
  return { enabled: true, ok: problems.length === 0 && complete, connections, frontIds, missingInFront, extraInFront, boxStoreEmpty, problems }
}

/** One sentence for the doctor summary ("" while the flag is off). */
export function keystoneAuthLine(report: KeystoneAuthReport): string {
  if (!report.enabled) return ""
  if ("unavailable" in report) return ` Keystone tokens (host): UNAVAILABLE (${report.unavailable.slice(0, 200)}).`
  if (report.ok) return ` Keystone tokens (host): ${report.connections.map((c) => `${c.connection} until ${c.expiresAt ?? "unknown"}`).join(", ") || "none chosen"}; front has each loaded; the box stores none.`
  const shown = report.problems.length ? report.problems : ["a chosen connection is not signed in and published"]
  return ` Keystone tokens (host): NOT ok: ${shown.join("; ").slice(0, 600)}.`
}
