// R3-01: oc_doctor reports the egress control honestly (configuration check, not traffic).
// R4-01: and the chosen Keystone set, with the front config generated for it.
import { afterAll, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { checkEgress, DOCKER_DIR, egressInput } from "../src/guard/egress-check.ts"
import { frontServersFor } from "../src/guard/egress.ts"
import { defaultConfig } from "../src/shared/config.ts"
import { saveKeystoneSet } from "../src/shared/keystone.ts"
import { doctorTool } from "../src/tools/doctor.ts"
import { data, fakeContext, invoke, text } from "./tools-core-fixture.ts"

const scratch = mkdtempSync(path.join(os.tmpdir(), "ocd-egress-doctor-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0

const CHOSEN = { "ks-rag-global": { status: "connected" }, "ks-github": { status: "connected" }, "ks-seqlogs": { status: "connected" } }
const healthy = (f: ReturnType<typeof fakeContext>) => f.api.on("GET /mcp", { status: 200, data: CHOSEN })

/** A bridge home whose front folder holds the servers file the bridge would generate (as after a start). */
function startedHome(keystone?: string[]): string {
  const home = path.join(scratch, `home-${n++}`)
  if (keystone) saveKeystoneSet(home, keystone)
  const config = { ...defaultConfig({}), home, ...(keystone ? { keystoneConnections: keystone } : {}) }
  mkdirSync(path.join(home, "front"), { recursive: true })
  writeFileSync(path.join(home, "front", "servers.conf"), frontServersFor(config))
  return home
}

describe("oc_doctor egress check", () => {
  test("the front config for the default hosts and Keystone set: reported ok, no CONNECT proxy, verified", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.config.home = startedHome()
    healthy(f)
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result)).toMatchObject({
      verified: true,
      egressHostsConfigured: f.ctx.config.egressHosts,
      keystone: {
        connections: ["rag-global", "github", "seqlogs"],
        source: "default",
        entries: [
          { id: "rag-global", name: "ks-rag-global", status: "connected" },
          { id: "github", name: "ks-github", status: "connected" },
          { id: "seqlogs", name: "ks-seqlogs", status: "connected" },
        ],
      },
      egress: { ok: true, control: "tls-front", source: "configuration", frontConfigMatches: true, frontMountReadOnly: true, aliasesMatch: true, connectProxy: false, upstreamTlsVerified: true, boxSealed: true, problems: [] },
    })
    expect(text(result)).toContain("Keystone services: rag-global, github, seqlogs (default).")
    expect(text(result)).toContain("Egress: TLS front (fixed upstreams, no CONNECT proxy) configured as generated from egressHosts and the chosen Keystone set.")
  })

  test("a saved set is shown as the saved choice; a chosen entry the box does not list is `missing` and NOT verified", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.config.home = startedHome(["rag-global", "m365"])
    // m365 is outside the default ceiling; the owner allowed it at launch (R5-03).
    f.ctx.config.keystoneAllowed = ["rag-global", "m365"]
    f.api.on("GET /mcp", { status: 200, data: { "ks-rag-global": { status: "connected" } } })
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result)).toMatchObject({ keystone: { connections: ["rag-global", "m365"], source: "saved", entries: [{ name: "ks-rag-global", status: "connected" }, { name: "ks-m365", status: "missing" }] } })
    // m365 is a high-risk id (R5-04): the summary and the report warn.
    expect(text(result)).toContain("Keystone services: rag-global, m365 (saved choice; WARNING high-risk allowed or chosen: m365).")
    expect(data(result)).toMatchObject({ keystone: { ceiling: ["rag-global", "m365"], highRisk: ["m365"], warnings: [expect.stringContaining("m365")] } })
  })

  test("a box running an entry outside the chosen set is NOT verified (guard policy_violation)", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.config.home = startedHome()
    f.api.on("GET /mcp", { status: 200, data: { ...CHOSEN, "ks-delegate": { status: "connected" } } })
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result)).toMatchObject({ verified: false, guard: { ok: false, code: "policy_violation" } })
  })

  test("a running front started for another set (frontMatches false) is NOT verified", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.config.home = startedHome()
    healthy(f)
    f.status.value = { ...f.status.value, ...(f.status.value.state === "running" ? { frontMatches: false } : {}) } as typeof f.status.value
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result)).toMatchObject({ verified: false, box: { frontMatches: false } })
    expect(text(result)).toContain("front MISMATCH")
  })

  test("a host list the front was not generated for is NOT verified, and the summary says so", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.config.home = startedHome()
    healthy(f)
    f.ctx.config.egressHosts = [...f.ctx.config.egressHosts, "rag.alterspective.com.au"]
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result)).toMatchObject({ verified: false, egress: { ok: false, frontConfigMatches: false, aliasesMatch: false } })
    expect(text(result)).toContain("NOT verified")
    expect(text(result)).toContain("Egress: TLS front (fixed upstreams, no CONNECT proxy) MISMATCH")
  })

  test("a damaged saved choice is reported, never thrown, and is NOT verified", async () => {
    const f = fakeContext({ boxHeld: false })
    f.ctx.config.home = startedHome()
    writeFileSync(path.join(f.ctx.config.home, "keystone.json"), "{broken")
    healthy(f)
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result)).toMatchObject({ verified: false, keystone: { unavailable: expect.stringContaining("damaged") }, egress: { ok: false } })
  })
})

// R4-05: drift in front's upstream TLS settings or in the box's network isolation is not ok.
describe("egress check: upstream TLS and the sealed network (R4-05)", () => {
  const input = egressInput({ ...defaultConfig({}), home: startedHome() })

  /** A copy of docker/ with `file` passed through `edit`. */
  function drifted(file: string, edit: (text: string) => string): string {
    const dir = path.join(scratch, `copy-${n++}`)
    cpSync(DOCKER_DIR, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}box${path.sep}`) })
    writeFileSync(path.join(dir, file), edit(readFileSync(path.join(dir, file), "utf8").replaceAll("\r\n", "\n")))
    return dir
  }
  const unchanged = (dir: string) => expect(checkEgress(input, dir)).toMatchObject({ ok: true, upstreamTlsVerified: true, boxSealed: true, problems: [] })

  test("an untouched copy is ok", () => unchanged(drifted("front/upstream.conf", (t) => t)))

  test("upstream verification or forced SNI switched off, or missing, is not ok", () => {
    const edits: Record<string, (t: string) => string> = {
      "verify off": (t) => t.replace("proxy_ssl_verify on;", "proxy_ssl_verify off;"),
      "verify removed": (t) => t.replace("proxy_ssl_verify on;", ""),
      "verify commented out": (t) => t.replace("proxy_ssl_verify on;", "# proxy_ssl_verify on;"),
      "server name off": (t) => t.replace("proxy_ssl_server_name on;", "proxy_ssl_server_name off;"),
      "verify on, then off again": (t) => `${t}\nproxy_ssl_verify off;\n`,
    }
    for (const [why, edit] of Object.entries(edits)) {
      const result = checkEgress(input, drifted("front/upstream.conf", edit))
      expect({ why, ok: result.ok, tls: result.upstreamTlsVerified, said: result.problems.some((p) => p.includes("upstream.conf")) }).toEqual({ why, ok: false, tls: false, said: true })
    }
  })

  test("a missing upstream.conf is not ok and says why", () => {
    const dir = drifted("front/upstream.conf", (t) => t)
    rmSync(path.join(dir, "front", "upstream.conf"))
    const result = checkEgress(input, dir)
    expect(result.ok).toBe(false)
    expect(result.problems.some((p) => p.startsWith("front/upstream.conf unreadable"))).toBe(true)
  })

  test("`sealed` not internal, or the box on another network too, is not ok", () => {
    const edits: Record<string, (t: string) => string> = {
      "sealed not internal": (t) => t.replace(/(\n  sealed:\n    internal: )true/, "$1false"),
      "sealed internal removed": (t) => t.replace(/(\n  sealed:\n)    internal: true\n/, "$1    {}\n"),
      "box also on outside": (t) => t.replace(/(\n  box:\n[\s\S]*?\n    networks: )\[sealed\]/, "$1[sealed, outside]"),
      "box on outside only": (t) => t.replace(/(\n  box:\n[\s\S]*?\n    networks: )\[sealed\]/, "$1[outside]"),
      "box network as a map": (t) => t.replace(/(\n  box:\n[\s\S]*?\n    networks: )\[sealed\]/, "$1{ sealed: {}, admin: {} }"),
    }
    for (const [why, edit] of Object.entries(edits)) {
      const dir = drifted("compose.yaml", edit)
      expect({ why, edited: readFileSync(path.join(dir, "compose.yaml"), "utf8") !== readFileSync(path.join(DOCKER_DIR, "compose.yaml"), "utf8").replaceAll("\r\n", "\n") }).toEqual({ why, edited: true })
      const result = checkEgress(input, dir)
      expect({ why, ok: result.ok, sealed: result.boxSealed, said: result.problems.length > 0 }).toEqual({ why, ok: false, sealed: false, said: true })
    }
  })
})
