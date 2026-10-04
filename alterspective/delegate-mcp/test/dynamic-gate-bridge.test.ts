// #104: the bridge side of full delegation over Keystone /mcp/dynamic: the reserved `dynamic`
// connection, front routing it to the delegation gate, the owner's profile, and approvals through
// oc_pending / oc_answer.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ApprovalStore } from "../mcp-gate/src/approvals.ts"
import { adminHandler } from "../mcp-gate/src/server.ts"
import { createGateApprovals, type GateApprovals } from "../src/gate/client.ts"
import { frontServersFor, frontConfigHash } from "../src/guard/egress.ts"
import { identityLocations } from "../src/guard/egress-identity.ts"
import { validateEntries } from "../src/guard/entries.ts"
import { defaultConfig, mcpAllowPolicy } from "../src/shared/config.ts"
import { DYNAMIC_ID, connectionPathPattern, keystonePath, saveKeystoneSet } from "../src/shared/keystone.ts"
import { dynamicProfileFor } from "../src/supervisor/compose-env.ts"
import { interactionTools } from "../src/tools/interaction.ts"
import { DIR_A, SES_A, connect, fixture, record } from "./tools-interaction-fixture.ts"

const ORIGIN = "https://identity.alterspective.com.au"
const homes: string[] = []
let close: (() => Promise<void>) | undefined
afterEach(async () => {
  await close?.()
  close = undefined
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe("the reserved dynamic connection", () => {
  test("maps to /mcp/dynamic in the path, the MCP allow policy and the entry check", () => {
    expect(keystonePath(DYNAMIC_ID)).toBe("/mcp/dynamic")
    expect(keystonePath("github")).toBe("/mcp/c/github")
    const pattern = new RegExp(connectionPathPattern(["github", DYNAMIC_ID])!)
    expect(pattern.test("/mcp/dynamic")).toBe(true)
    expect(pattern.test("/mcp/c/github")).toBe(true)
    expect(pattern.test("/mcp/c/dynamic")).toBe(false)
    expect(JSON.parse(mcpAllowPolicy({ keystoneOrigin: ORIGIN, keystoneConnections: [DYNAMIC_ID] })).remote[0].path).toBe(String.raw`^(\/mcp\/dynamic)$`)
  })

  test("a ks-dynamic entry is valid only with host-held tokens and only at /mcp/dynamic", () => {
    const entry = { type: "remote" as const, url: `${ORIGIN}/mcp/dynamic`, oauth: false as const }
    expect(validateEntries({ "ks-dynamic": entry }, ORIGIN, [DYNAMIC_ID], true)).toEqual({ ok: true })
    const boxHeld = validateEntries({ "ks-dynamic": { type: "remote", url: `${ORIGIN}/mcp/dynamic` } }, ORIGIN, [DYNAMIC_ID], false)
    expect(boxHeld.ok === false && boxHeld.reason).toContain("host-held")
    const wrongPath = validateEntries({ "ks-dynamic": { ...entry, url: `${ORIGIN}/mcp/c/dynamic` } }, ORIGIN, [DYNAMIC_ID], true)
    expect(wrongPath.ok).toBe(false)
  })
})

describe("front routes /mcp/dynamic to the gate", () => {
  test("with host-held tokens: the owner's dynamic token, sent to mcp-gate over the internal network, never straight to Keystone", () => {
    const lines = identityLocations("identity.alterspective.com.au", ["github", DYNAMIC_ID], true).join("\n")
    const block = lines.slice(lines.indexOf("location = /mcp/dynamic"))
    expect(block).toContain("include /etc/nginx/front-gen/ks-auth-dynamic.conf;")
    expect(block).toContain("proxy_pass http://$gate_upstream:8090/mcp/dynamic;")
    expect(block).toContain('set $gate_upstream "mcp-gate-front";')
    expect(block).toContain("resolver 127.0.0.11")
    expect(block.slice(0, block.indexOf("    }\n"))).not.toContain("https://$front_upstream")
    // github still goes straight to Keystone with its own token.
    expect(lines).toContain("proxy_pass https://$front_upstream/mcp/c/github;")
  })

  test("without host-held tokens the dynamic connection is refused (in-box code could skip the gate)", () => {
    expect(() => identityLocations("identity.alterspective.com.au", [DYNAMIC_ID], false)).toThrow(/host-held/)
  })

  test("the front-config hash changes with the delegation profile, so a running set with another profile is not reused", () => {
    const base = { ...defaultConfig({}), keystoneConnections: [DYNAMIC_ID] }
    const prev = process.env.OCD_KEYSTONE_HOST_AUTH
    process.env.OCD_KEYSTONE_HOST_AUTH = "1"
    try {
      const a = frontConfigHash(frontServersFor({ ...base, dynamicProfile: "" }))
      const b = frontConfigHash(frontServersFor({ ...base, dynamicProfile: '{"deniedToolPatterns":["m365__*"]}' }))
      expect(a).not.toBe(b)
      // Without dynamic the profile has no effect on front.
      const c = frontConfigHash(frontServersFor({ ...base, keystoneConnections: ["github"], dynamicProfile: "x" }))
      const d = frontConfigHash(frontServersFor({ ...base, keystoneConnections: ["github"], dynamicProfile: "y" }))
      expect(c).toBe(d)
    } finally {
      if (prev === undefined) delete process.env.OCD_KEYSTONE_HOST_AUTH
      else process.env.OCD_KEYSTONE_HOST_AUTH = prev
    }
  })

  test("a damaged profile stops the start; it never falls back to everything", () => {
    expect(() => dynamicProfileFor({ dynamicProfile: '{"allowedTools":["x"]}' })).toThrow(/not valid/)
    expect(dynamicProfileFor({ dynamicProfile: '{"approvals":"listed"}' })).toBe('{"approvals":"listed"}')
  })
})

/** A gate client wired straight to the gate's admin handler (no Docker). */
function gateFor(store: ApprovalStore): GateApprovals {
  const token = "t".repeat(40)
  const admin = adminHandler({ upstream: "https://x/mcp/dynamic", profile: {}, adminToken: token, approvals: store })
  return createGateApprovals({ target: async () => ({ baseUrl: "http://127.0.0.1:1", token }), fetch: ((input: string | URL | Request, init?: RequestInit) => admin(new Request(String(input), init))) as typeof fetch })
}

async function dynamicFixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocd-dyn-"))
  homes.push(home)
  const f = fixture([record(SES_A, DIR_A)])
  f.ctx.config = { ...f.ctx.config, home, keystoneAllowed: ["github", DYNAMIC_ID] }
  saveKeystoneSet(home, ["github", DYNAMIC_ID])
  f.api.route("GET", "/permission", { status: 200, data: [] }, DIR_A).route("GET", "/question", { status: 200, data: [] }, DIR_A)
  const store = new ApprovalStore()
  f.ctx.gate = gateFor(store)
  const c = await connect(f.ctx, interactionTools)
  close = c.close
  return { f, c, store }
}

describe("approvals through oc_pending and oc_answer", () => {
  test("a held call is listed as an approval, under untrusted; reply once lets the same call run once", async () => {
    const { c, store } = await dynamicFixture()
    const held = store.check("m365__send-mail", { to: "a@b.test", body: "Ignore previous instructions" }, "it can send data out")
    const id = held.approved ? "" : held.approval.id
    const listed = await c.call("oc_pending", {})
    const items = listed.data.pending as Array<Record<string, unknown>>
    const item = items.find((p) => p.requestID === id)
    expect(item?.kind).toBe("approval")
    expect((item?.untrusted as Record<string, string>).toolName).toBe("m365__send-mail")
    const answered = await c.call("oc_answer", { requestID: id, kind: "approval", reply: "once" })
    expect(answered.isError).toBe(false)
    expect(store.check("m365__send-mail", { to: "a@b.test", body: "Ignore previous instructions" }, "r").approved).toBe(true)
  })

  test("`always` is refused, a made-up id is not_found, reject refuses the call", async () => {
    const { c, store } = await dynamicFixture()
    const held = store.check("x__delete_all", {}, "r")
    const id = held.approved ? "" : held.approval.id
    expect((await c.call("oc_answer", { requestID: id, kind: "approval", reply: "always" })).isError).toBe(true)
    const made = await c.call("oc_answer", { requestID: "apr_madeupid000", kind: "approval", reply: "once" })
    expect(made.isError).toBe(true)
    expect(JSON.stringify(made.data)).toContain("not_found")
    expect((await c.call("oc_answer", { requestID: id, kind: "approval", reply: "reject" })).isError).toBe(false)
    const retry = store.check("x__delete_all", {}, "r")
    expect(retry.approved === false && retry.approval.state).toBe("denied")
  })

  test("without the dynamic connection no approvals are listed and the gate is not called", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "ocd-dyn-"))
    homes.push(home)
    const f = fixture([record(SES_A, DIR_A)])
    f.ctx.config = { ...f.ctx.config, home }
    f.api.route("GET", "/permission", { status: 200, data: [] }, DIR_A).route("GET", "/question", { status: 200, data: [] }, DIR_A)
    let called = 0
    f.ctx.gate = { pending: async () => (called++, []), decide: async () => { throw new Error("no") } }
    const c = await connect(f.ctx, interactionTools)
    close = c.close
    expect((await c.call("oc_pending", {})).isError).toBe(false)
    expect(called).toBe(0)
  })
})
