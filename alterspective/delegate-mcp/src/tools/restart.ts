// oc_server_restart: replace the sandbox with one built from this bridge's profile and image (the
// fix for profile_changed). It needs no lease, so it works even when ensure() refuses the running
// box. The supervisor stops (compose down, never -v) and starts it under the start lock. While
// other bridges use the box it is refused unless force:true, because their running sessions are
// interrupted; the result says how many were. confirm:true is always required.
// `keystone` (review R4-01) changes the box-wide set of Keystone services: the profile, the MCP
// policy and the front proxy's allowed Keystone paths are all regenerated for it, and the choice
// is saved in the bridge home so later bridges and restarts reuse it. Ids must sit inside the
// owner's ceiling (OPENCODE_DELEGATE_KEYSTONE_ALLOWED, launch env, R5-03): this tool cannot raise
// it, because `confirm` is a value the calling model supplies.
import { z } from "zod"
import { CONNECTION_ID, MAX_CONNECTIONS } from "../shared/keystone.ts"
import { DelegateError } from "../shared/errors.ts"
import { defineTool } from "./define.ts"
import { ok } from "./shape.ts"

function summaryOf(interrupted: number, keystone: string[]): string {
  const services = `Keystone services: ${keystone.length ? keystone.join(", ") : "none"}.`
  if (interrupted === 0) return `The sandbox was replaced and is running again. ${services} Sessions keep their history; check them with oc_status.`
  const who = interrupted === 1 ? "1 other bridge" : `${interrupted} other bridges`
  return `The sandbox was replaced and is running again. ${services} ${who} had running sessions interrupted; sessions keep their history.`
}

export const restartTool = defineTool({
  name: "oc_server_restart",
  title: "Restart the sandbox",
  description:
    "Replace the OpenCode sandbox: stop it and start it again with this bridge's profile and image (fixes profile_changed). Interrupts running sessions. Refused while other bridges use the sandbox unless force is true. Requires confirm: true. " +
    "Optional keystone: the Keystone connection ids the box may use from now on (box-wide, saved for later restarts; default rag-read, github, seqlogs). Only these services are reachable from the box; new ones may need oc_login. " +
    "Ids must be in the owner's allowed list (OPENCODE_DELEGATE_KEYSTONE_ALLOWED in this MCP server's env; default: the default set); others are refused with policy_violation and only the owner can add them. One connection can relay to other services (e.g. agents that read mail, admin tools, secrets), so a chosen id may reach more than its name says.",
  input: {
    confirm: z.boolean().describe("Must be true: running sessions are interrupted."),
    force: z.boolean().optional().describe("Replace the sandbox even while other bridges use it (their running sessions are interrupted). Default false."),
    keystone: z
      .array(z.string().regex(CONNECTION_ID, "a Keystone connection id (lower-case, digits, '-')"))
      .max(MAX_CONNECTIONS)
      .optional()
      .describe("Keystone connection ids (/mcp/c/<id>) the box may use, e.g. [\"rag-read\", \"github\"]. Replaces the saved choice. Omit to keep it."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async run(args, ctx) {
    if (args.confirm !== true)
      throw new DelegateError("invalid_input", "The restart was not confirmed; nothing was stopped.", "Call oc_server_restart with confirm: true once running sessions may be interrupted.")
    if (!args.force) {
      const box = ctx.peekBox() ?? (await ctx.box().catch(() => undefined))
      if (box) {
        const states = await ctx.workspaces.listSessionStates().catch(() => [])
        const activeOther: string[] = []
        for (const s of states) {
          if (!s.sessionID) continue
          const isOther = Boolean(s.caller && (!ctx.caller || s.caller !== ctx.caller))
          if (!isOther) continue
          const view = await box.hub.view(s.sessionID).catch(() => undefined)
          if (view && (view.state === "busy" || view.state === "starting" || view.state === "retry")) {
            activeOther.push(`${s.sessionID} (${s.caller}: ${view.state})`)
          }
        }
        for (const [id, rec] of ctx.sessions.entries()) {
          const isOther = Boolean(rec.caller && (!ctx.caller || rec.caller !== ctx.caller))
          if (!isOther) continue
          if (states.some((s) => s.sessionID === id)) continue
          const view = await box.hub.view(id).catch(() => undefined)
          if (view && (view.state === "busy" || view.state === "starting" || view.state === "retry")) {
            activeOther.push(`${id} (${rec.caller}: ${view.state})`)
          }
        }
        if (activeOther.length > 0) {
          throw new DelegateError(
            "policy_violation",
            `Other callers have active sessions: ${activeOther.join(", ")}.`,
            "Wait for them to finish, or call oc_server_restart with force: true.",
          )
        }
      }
    }
    const box = await ctx.restartBox({ force: args.force === true, ...(args.keystone ? { keystone: args.keystone } : {}) })
    const status = await ctx.supervisorService.status()
    return ok(summaryOf(box.interrupted, box.keystone), {
      restarted: true,
      interrupted: box.interrupted,
      keystone: box.keystone,
      state: status.state,
      imageTag: status.state === "running" ? status.imageTag : undefined,
      baseUrl: box.target.baseUrl,
    })
  },
})
