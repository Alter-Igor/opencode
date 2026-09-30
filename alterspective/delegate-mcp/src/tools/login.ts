// oc_login (technical-design §4 "Keystone sign-in"): the supervisor's login relay. The box starts
// the OAuth flow, the owner's browser opens on the Keystone page, and only the code is relayed back.
import { z } from "zod"
import { KS_NAME } from "../guard/entries.ts"
import { defineTool } from "./define.ts"
import { ok } from "./shape.ts"

export const loginTool = defineTool({
  name: "oc_login",
  title: "Sign the sandbox in to Keystone",
  description:
    "Sign one Keystone MCP entry of the sandbox in as the owner: opens the owner's browser on the Keystone sign-in page and waits (up to 5 minutes) for it to finish. Returns connected or failed.",
  input: { server: z.string().regex(KS_NAME, "a ks-* entry name").max(67).optional().describe("The ks-* entry to sign in. Default ks-delegate.") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async run(args, ctx) {
    const server = args.server ?? "ks-delegate"
    await ctx.box()
    const result = await ctx.supervisorService.login(server)
    const summary = result === "connected" ? `${server} is connected.` : `${server} sign-in did not finish (failed). Retry oc_login; see oc_doctor for the entry state.`
    return ok(summary, { server, result })
  },
})
