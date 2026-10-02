// oc_login (technical-design §4 "Keystone sign-in"): the supervisor's login relay. The box starts
// the OAuth flow, the owner's browser opens on the Keystone page, and only the code is relayed back.
// With no `server`, every chosen Keystone entry (ks-<id>, review R4-01) that needs sign-in is signed
// in, one at a time; it stops at the first one that does not finish, so the owner is not sent a
// string of browser tabs after closing one.
// #67 step 4: with host-held Keystone tokens (OCD_KEYSTONE_HOST_AUTH=1, ctx.keystone set) the
// sign-in runs on the HOST (keystone-auth signIn, same loopback port), front adds the token, and
// the box entry is then connected. The box sign-in relay is not used at all.
import { z } from "zod"
import { KS_NAME } from "../guard/entries.ts"
import { ensureEntryConnected } from "../keystone-auth/host-wiring.ts"
import type { KeystoneAuth, KsStatus } from "../keystone-auth/index.ts"
import { currentKeystone } from "../shared/config.ts"
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { entryName, idOfEntry } from "../shared/keystone.ts"
import type { McpStatus, OpencodeApi } from "../shared/opencode-api.ts"
import type { ToolContext } from "./context.ts"
import { defineTool } from "./define.ts"
import { ok } from "./shape.ts"

/** WS2 (#48): `oc_login {server: "synapse"}` signs the owner in to Synapse on the HOST (src/synapse). */
export const SYNAPSE_SERVER = "synapse"

async function signInSynapse(ctx: ToolContext) {
  const result = await ctx.synapse.signIn()
  const front = result.reload === "reloaded" ? "front reloaded" : result.reload === "front_not_running" ? "front not running (it loads the token when the sandbox starts)" : result.reload === "config_changed" ? "front did NOT reload: its generated files are not the ones it started with (restart the sandbox: oc_server_restart {confirm: true})" : result.reload === "unverified" ? "front did not confirm the reload in time (the bridge retries; run oc_doctor)" : result.reload === "busy" ? "front was busy with another reload (the bridge retries; run oc_doctor)" : "front REFUSED the new config (it keeps the last good one; run oc_doctor)"
  return ok(`Synapse signed in on the host${result.user ? ` as ${result.user}` : ""}; token until ${new Date(result.expiresAt).toISOString()}, renewed silently; ${front}.`, {
    server: SYNAPSE_SERVER,
    result: "connected",
    ...(result.user ? { user: result.user } : {}),
    expiresAt: new Date(result.expiresAt).toISOString(),
    reload: result.reload,
  })
}

type Outcome = { server: string; result: "connected" | "failed" }

/** Status of each chosen entry in the box (GET /mcp); an entry the box does not list is `missing`. */
async function chosenStatuses(api: OpencodeApi, names: string[], correlationId: string): Promise<Record<string, string>> {
  const res = await api.call<Record<string, McpStatus>>({ path: "/mcp", directory: "/sessions", correlationId })
  if (res.status !== 200 || !res.data || typeof res.data !== "object")
    throw new DelegateError("upstream_error", "The delegate server did not list its MCP entries.", "Retry; if it repeats, run oc_doctor.", `HTTP ${res.status}`)
  return Object.fromEntries(names.map((name) => [name, typeof res.data?.[name]?.status === "string" ? String(res.data[name]?.status) : "missing"]))
}

/** One named entry: it must be one of the chosen connections. */
async function signInOne(ctx: ToolContext, server: string, connections: string[]) {
  const id = idOfEntry(server)
  if (id === undefined || !connections.includes(id))
    throw new DelegateError("invalid_input", `${server} is not one of the sandbox's Keystone services.`, `Use one of ${connections.map(entryName).join(", ") || "(none)"}, or add it with oc_server_restart {keystone}.`)
  const result = await ctx.supervisorService.login(server)
  const summary = result === "connected" ? `${server} is connected.` : `${server} sign-in did not finish (failed). Retry oc_login; see oc_doctor for the entry state.`
  return ok(summary, { server, result })
}

/** Every chosen entry that needs sign-in, in order; stops at the first that fails. */
async function signInAll(ctx: ToolContext, connections: string[], correlationId: string) {
  const box = await ctx.box()
  const names = connections.map(entryName)
  const before = await chosenStatuses(box.api, names, correlationId)
  const pending = names.filter((name) => before[name] === "needs_auth")
  const results: Outcome[] = []
  for (const server of pending) {
    results.push({ server, result: await ctx.supervisorService.login(server) })
    if (results.at(-1)?.result === "failed") break
  }
  const skipped = pending.slice(results.length)
  const done = results.filter((r) => r.result === "connected").map((r) => r.server)
  const failed = results.find((r) => r.result === "failed")?.server
  const summary = pending.length === 0
    ? "No Keystone entry needs sign-in."
    : `Signed in: ${done.join(", ") || "none"}.${failed ? ` ${failed} did not finish; retry oc_login.` : ""}${skipped.length ? ` Not tried: ${skipped.join(", ")}.` : ""}`
  return ok(summary, { results, skipped, before })
}

type HostKeystone = Pick<KeystoneAuth, "signIn" | "status">
/** Host states a sign-in fixes; the others renew by themselves (or are mid-save). */
const NEEDS_HOST_SIGN_IN: ReadonlySet<KsStatus["state"]> = new Set<KsStatus["state"]>(["needs_sign_in", "signed_out", "expired"])

type HostOutcome = { server: string; result: "connected" | "failed"; outcome: string; expiresAt?: string; box?: string }

/** Sign one connection in on the host, then connect its box entry when this bridge holds a box. */
async function hostSignIn(ctx: ToolContext, ks: HostKeystone, id: string): Promise<HostOutcome> {
  const server = entryName(id)
  const signed = await ks.signIn(id)
  const held = ctx.peekBox()
  const box = held && signed.outcome === "signed_in" ? await ensureEntryConnected(held.api, server, ctx.log).catch(() => "unknown") : held ? undefined : "not_running"
  return {
    server,
    result: signed.outcome === "signed_in" ? "connected" : "failed",
    outcome: signed.outcome,
    ...(signed.expiresAt > 0 ? { expiresAt: new Date(signed.expiresAt).toISOString() } : {}),
    ...(box ? { box } : {}),
  }
}

const hostWords = (o: HostOutcome) =>
  o.result === "connected"
    ? `${o.server} signed in on the host${o.expiresAt ? `; token until ${o.expiresAt}, renewed silently` : ""}${o.box === "not_running" ? "; the sandbox is not running (front loads the token when it starts)" : o.box ? `; box entry ${o.box}` : ""}.`
    : `${o.server} sign-in did not finish (${o.outcome}). Retry oc_login; see oc_doctor keystoneAuth.`

async function hostSignInOne(ctx: ToolContext, ks: HostKeystone, server: string, connections: string[]) {
  const id = idOfEntry(server)
  if (id === undefined || !connections.includes(id))
    throw new DelegateError("invalid_input", `${server} is not one of the sandbox's Keystone services.`, `Use one of ${connections.map(entryName).join(", ") || "(none)"}, or add it with oc_server_restart {keystone}.`)
  const outcome = await hostSignIn(ctx, ks, id)
  return ok(hostWords(outcome), { ...outcome, host: true })
}

/** Every chosen connection the host store says needs sign-in, in order; stops at the first that does not finish. */
async function hostSignInAll(ctx: ToolContext, ks: HostKeystone, connections: string[]) {
  const before = await ks.status(connections)
  const pending = before.filter((s) => NEEDS_HOST_SIGN_IN.has(s.state)).map((s) => s.connection)
  const results: HostOutcome[] = []
  for (const id of pending) {
    try {
      results.push(await hostSignIn(ctx, ks, id))
    } catch (error) {
      results.push({ server: entryName(id), result: "failed", outcome: isDelegateError(error) ? error.code : "error" })
    }
    if (results.at(-1)?.result === "failed") break
  }
  const skipped = pending.slice(results.length).map(entryName)
  const summary = pending.length === 0 ? "No Keystone connection needs sign-in on the host." : `${results.map(hostWords).join(" ")}${skipped.length ? ` Not tried: ${skipped.join(", ")}.` : ""}`
  return ok(summary, { host: true, results, skipped, before: Object.fromEntries(before.map((s) => [entryName(s.connection), s.state])) })
}

export const loginTool = defineTool({
  name: "oc_login",
  title: "Sign the sandbox in to Keystone",
  description:
    "Sign the sandbox's Keystone MCP entries (ks-<id>) in as the owner: opens the owner's browser on the Keystone sign-in page and waits (up to 5 minutes per entry) for it to finish. With no server, signs in every entry that needs it, one at a time, stopping at the first that does not finish. Returns connected or failed per entry. With host-held Keystone tokens (OCD_KEYSTONE_HOST_AUTH=1) the sign-in runs on the HOST and the box never holds the token: front adds it, the bridge renews it and connects the box entry. server \"synapse\" signs the owner in to the Synapse model gateway on the HOST (app opencode); the box never holds that token, front adds it, and the bridge renews it silently.",
  input: {
    server: z
      .union([z.literal(SYNAPSE_SERVER), z.string().regex(KS_NAME, "a ks-<id> entry name").max(67)])
      .optional()
      .describe("One ks-<id> entry to sign in, or \"synapse\" for the model gateway. Default: every Keystone entry that needs sign-in."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async run(args, ctx, correlationId) {
    if (args.server === SYNAPSE_SERVER) return signInSynapse(ctx)
    const connections = currentKeystone(ctx.config).connections
    if (ctx.keystone) return args.server === undefined ? hostSignInAll(ctx, ctx.keystone, connections) : hostSignInOne(ctx, ctx.keystone, args.server, connections)
    if (args.server === undefined) return signInAll(ctx, connections, correlationId)
    await ctx.box()
    return signInOne(ctx, args.server, connections)
  },
})
