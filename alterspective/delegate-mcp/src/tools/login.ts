// oc_login (technical-design §4 "Keystone sign-in"): the supervisor's login relay. The box starts
// the OAuth flow, the owner's browser opens on the Keystone page, and only the code is relayed back.
// With no `server`, every chosen Keystone entry (ks-<id>, review R4-01) that needs sign-in is signed
// in, one at a time; it stops at the first one that does not finish, so the owner is not sent a
// string of browser tabs after closing one.
import { z } from "zod"
import { KS_NAME } from "../guard/entries.ts"
import { currentKeystone } from "../shared/config.ts"
import { DelegateError } from "../shared/errors.ts"
import { entryName, idOfEntry } from "../shared/keystone.ts"
import type { McpStatus, OpencodeApi } from "../shared/opencode-api.ts"
import type { ToolContext } from "./context.ts"
import { defineTool } from "./define.ts"
import { ok } from "./shape.ts"

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

export const loginTool = defineTool({
  name: "oc_login",
  title: "Sign the sandbox in to Keystone",
  description:
    "Sign the sandbox's Keystone MCP entries (ks-<id>) in as the owner: opens the owner's browser on the Keystone sign-in page and waits (up to 5 minutes per entry) for it to finish. With no server, signs in every entry that needs it, one at a time, stopping at the first that does not finish. Returns connected or failed per entry.",
  input: { server: z.string().regex(KS_NAME, "a ks-<id> entry name").max(67).optional().describe("One ks-<id> entry to sign in. Default: every Keystone entry that needs sign-in.") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async run(args, ctx, correlationId) {
    const connections = currentKeystone(ctx.config).connections
    if (args.server === undefined) return signInAll(ctx, connections, correlationId)
    await ctx.box()
    return signInOne(ctx, args.server, connections)
  },
})
