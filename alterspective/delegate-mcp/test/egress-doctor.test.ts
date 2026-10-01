// R3-01: oc_doctor reports the egress control honestly (configuration check, not traffic).
import { describe, expect, test } from "bun:test"
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
      egress: { ok: true, control: "tls-front", source: "configuration", frontConfigMatches: true, aliasesMatch: true, connectProxy: false, problems: [] },
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
