// R3-01: oc_doctor reports the egress control honestly (configuration check, not traffic).
import { afterAll, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { checkEgress, DOCKER_DIR } from "../src/guard/egress-check.ts"
import { defaultConfig } from "../src/shared/config.ts"
import { doctorTool } from "../src/tools/doctor.ts"
import { data, fakeContext, invoke, text } from "./tools-core-fixture.ts"

const healthy = (f: ReturnType<typeof fakeContext>) => f.api.on("GET /mcp", { status: 200, data: { "ks-delegate": { status: "connected" } } })

describe("oc_doctor egress check", () => {
  test("the committed front config for the default hosts: reported ok, no CONNECT proxy, verified", async () => {
    const f = fakeContext({ boxHeld: false })
    healthy(f)
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result)).toMatchObject({
      verified: true,
      egressHostsConfigured: f.ctx.config.egressHosts,
      egress: { ok: true, control: "tls-front", source: "configuration", frontConfigMatches: true, aliasesMatch: true, connectProxy: false, upstreamTlsVerified: true, boxSealed: true, problems: [] },
    })
    expect(text(result)).toContain("Egress: TLS front (fixed upstreams, no CONNECT proxy) configured as generated from egressHosts.")
  })

  test("a host list the front was not generated for is NOT verified, and the summary says so", async () => {
    const f = fakeContext({ boxHeld: false })
    healthy(f)
    f.ctx.config.egressHosts = [...f.ctx.config.egressHosts, "rag.alterspective.com.au"]
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result)).toMatchObject({ verified: false, egress: { ok: false, frontConfigMatches: false, aliasesMatch: false } })
    expect(text(result)).toContain("NOT verified")
    expect(text(result)).toContain("Egress: TLS front (fixed upstreams, no CONNECT proxy) MISMATCH")
  })
})

// R4-05: drift in front's upstream TLS settings or in the box's network isolation is not ok.
describe("egress check: upstream TLS and the sealed network (R4-05)", () => {
  const hosts = defaultConfig({}).egressHosts
  const scratch = mkdtempSync(path.join(os.tmpdir(), "ocd-egress-doctor-"))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))
  let n = 0

  /** A copy of docker/ with `file` passed through `edit`. */
  function drifted(file: string, edit: (text: string) => string): string {
    const dir = path.join(scratch, `copy-${n++}`)
    cpSync(DOCKER_DIR, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}box${path.sep}`) })
    writeFileSync(path.join(dir, file), edit(readFileSync(path.join(dir, file), "utf8").replaceAll("\r\n", "\n")))
    return dir
  }
  const unchanged = (dir: string) => expect(checkEgress(hosts, dir)).toMatchObject({ ok: true, upstreamTlsVerified: true, boxSealed: true, problems: [] })

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
      const result = checkEgress(hosts, drifted("front/upstream.conf", edit))
      expect({ why, ok: result.ok, tls: result.upstreamTlsVerified, said: result.problems.some((p) => p.includes("upstream.conf")) }).toEqual({ why, ok: false, tls: false, said: true })
    }
  })

  test("a missing upstream.conf is not ok and says why", () => {
    const dir = drifted("front/upstream.conf", (t) => t)
    rmSync(path.join(dir, "front", "upstream.conf"))
    const result = checkEgress(hosts, dir)
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
      const result = checkEgress(hosts, dir)
      expect({ why, ok: result.ok, sealed: result.boxSealed, said: result.problems.length > 0 }).toEqual({ why, ok: false, sealed: false, said: true })
    }
  })
})
