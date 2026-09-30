// oc_server_restart: replace the sandbox with one built from this bridge's profile and image (the
// fix for profile_changed). It needs no lease, so it works even when ensure() refuses the running
// box. The supervisor stops (compose down, never -v) and starts it under the start lock. While
// other bridges use the box it is refused unless force:true, because their running sessions are
// interrupted; the result says how many were. confirm:true is always required.
import { z } from "zod"
import { DelegateError } from "../shared/errors.ts"
import { defineTool } from "./define.ts"
import { ok } from "./shape.ts"

function summaryOf(interrupted: number): string {
  if (interrupted === 0) return "The sandbox was replaced and is running again. Sessions keep their history; check them with oc_status."
  const who = interrupted === 1 ? "1 other bridge" : `${interrupted} other bridges`
  return `The sandbox was replaced and is running again. ${who} had running sessions interrupted; sessions keep their history.`
}

export const restartTool = defineTool({
  name: "oc_server_restart",
  title: "Restart the sandbox",
  description:
    "Replace the OpenCode sandbox: stop it and start it again with this bridge's profile and image (fixes profile_changed). Interrupts running sessions. Refused while other bridges use the sandbox unless force is true. Requires confirm: true.",
  input: {
    confirm: z.boolean().describe("Must be true: running sessions are interrupted."),
    force: z.boolean().optional().describe("Replace the sandbox even while other bridges use it (their running sessions are interrupted). Default false."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async run(args, ctx) {
    if (args.confirm !== true)
      throw new DelegateError("invalid_input", "The restart was not confirmed; nothing was stopped.", "Call oc_server_restart with confirm: true once running sessions may be interrupted.")
    const box = await ctx.restartBox({ force: args.force === true })
    const status = await ctx.supervisorService.status()
    return ok(summaryOf(box.interrupted), {
      restarted: true,
      interrupted: box.interrupted,
      state: status.state,
      imageTag: status.state === "running" ? status.imageTag : undefined,
      baseUrl: box.target.baseUrl,
    })
  },
})
