// oc_server_restart: release this bridge's lease and ensure the sandbox again. When this bridge
// holds the last lease the sandbox stops and starts with this bridge's profile (the fix for
// profile_changed); running sessions of every bridge are interrupted, so confirm:true is required.
import { z } from "zod"
import { DelegateError } from "../shared/errors.ts"
import { defineTool } from "./define.ts"
import { ok } from "./shape.ts"

export const restartTool = defineTool({
  name: "oc_server_restart",
  title: "Restart the sandbox",
  description:
    "Restart the OpenCode sandbox: release this bridge's lease, stop the sandbox when no other bridge holds one, and start it again with this bridge's profile. Interrupts running sessions (of every bridge). Requires confirm: true.",
  input: { confirm: z.boolean().describe("Must be true: running sessions are interrupted.") },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async run(args, ctx) {
    if (args.confirm !== true)
      throw new DelegateError("invalid_input", "The restart was not confirmed; nothing was stopped.", "Call oc_server_restart with confirm: true once running sessions may be interrupted.")
    const prior = await ctx.supervisorService.status()
    const before = prior.state === "running" ? prior.target.baseUrl : undefined
    const box = await ctx.restartBox()
    const status = await ctx.supervisorService.status()
    // Each start publishes a new random port, so an unchanged URL means the running box was kept.
    const restarted = before !== box.target.baseUrl
    const summary = restarted
      ? "The sandbox is running again. Sessions keep their history; check them with oc_status."
      : "Other bridges still hold the sandbox, so it was kept running (nothing restarted). Close their sessions, then retry."
    return ok(summary, { restarted, state: status.state, imageTag: status.state === "running" ? status.imageTag : undefined, baseUrl: box.target.baseUrl })
  },
})
