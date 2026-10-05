import { afterAll, describe, expect, test } from "bun:test"
import net from "net"
import { FORBIDDEN_V4, TABLE, cidrRange, parseAllow, parseCounters, renderRuleset } from "../egress/rules"
import { MUST_BE_BLOCKED, decide, probePlan, type CheckResult, type Observations } from "../egress/verdict"
import { checkUnreachable } from "../supervisor/egress-guard"

// #118 (svc-coding-agent#46): the in-sandbox egress lockdown.

describe("parseAllow / cidrRange", () => {
  test("parses ip:port and cidr:port lists", () => {
    expect(parseAllow("203.0.113.10:443, 198.51.100.0/24:8443")).toEqual([
      { cidr: "203.0.113.10", port: 443 },
      { cidr: "198.51.100.0/24", port: 8443 },
    ])
    expect(parseAllow(undefined)).toEqual([])
    expect(parseAllow("  ")).toEqual([])
  })

  test("refuses anything that is not an IPv4 ip:port", () => {
    for (const bad of ["example.com:443", "1.2.3.4", "1.2.3.4:0", "1.2.3.4:70000", "1.2.3.256:443", "1.2.3.4/33:443", "[::1]:443"]) {
      expect(() => parseAllow(bad)).toThrow()
    }
  })

  test("cidrRange covers the block", () => {
    expect(cidrRange("10.0.0.0/8")).toEqual([167772160, 184549375])
    expect(cidrRange("1.2.3.4")).toEqual([16909060, 16909060])
  })
})

describe("renderRuleset", () => {
  const text = renderRuleset({ allow: [{ cidr: "203.0.113.10", port: 443 }] })
  const ip = text.slice(text.indexOf(`table ip ${TABLE} {`), text.indexOf(`table ip6 ${TABLE} {`))
  const ip6 = text.slice(text.indexOf(`table ip6 ${TABLE} {`))
  const at = (needle: string) => ip.indexOf(needle)

  test("two default-drop tables, ip and ip6 (no inet family in the E2B kernel)", () => {
    expect(text).not.toContain("inet")
    expect(ip).toContain("policy drop;")
    expect(ip6).toContain("policy drop;")
    expect(ip6).toContain('ip6 daddr fe80::/10 counter drop comment "ipv6-link-local"')
    expect(ip6).toContain('counter drop comment "ipv6"')
  })

  test("re-runnable: each table is added and deleted before it is defined", () => {
    expect(text.indexOf(`add table ip ${TABLE}`)).toBeLessThan(text.indexOf(`table ip ${TABLE} {`))
    expect(text).toContain(`delete table ip6 ${TABLE}`)
  })

  test("replies are accepted before the private-range drops (the E2B SDK needs them)", () => {
    expect(at("ct state established,related accept")).toBeLessThan(at('comment "private"'))
    expect(at('oif "lo" accept')).toBeLessThan(at('comment "metadata"'))
  })

  test("every forbidden range is dropped and counted before any allow rule", () => {
    for (const f of FORBIDDEN_V4) expect(ip).toContain(`ip daddr ${f.cidr} counter drop comment "${f.label}"`)
    const lastForbidden = Math.max(...FORBIDDEN_V4.map((f) => at(`ip daddr ${f.cidr} `)))
    expect(lastForbidden).toBeLessThan(at('comment "allow"'))
    expect(at('comment "allow"')).toBeLessThan(at('counter drop comment "default"'))
  })

  test("allow entries become tcp port rules; DNS only when a resolver is given", () => {
    expect(ip).toContain('ip daddr 203.0.113.10 tcp dport 443 accept comment "allow"')
    expect(text).not.toContain("dport 53")
    expect(renderRuleset({ allow: [], dns: "203.0.113.53" })).toContain("ip daddr 203.0.113.53 meta l4proto { tcp, udp } th dport 53 accept")
  })

  test("an allow entry or resolver inside a forbidden range is refused, loudly", () => {
    expect(() => renderRuleset({ allow: [{ cidr: "169.254.169.254", port: 80 }] })).toThrow(/metadata/)
    expect(() => renderRuleset({ allow: [{ cidr: "10.1.2.3", port: 443 }] })).toThrow(/private/)
    expect(() => renderRuleset({ allow: [{ cidr: "0.0.0.0/0", port: 443 }] })).toThrow(/forbidden/)
    expect(() => renderRuleset({ allow: [], dns: "192.168.1.1" })).toThrow(/private/)
    expect(() => renderRuleset({ allow: [], dns: "not-an-ip" })).toThrow()
  })
})

describe("parseCounters", () => {
  test("sums packets by comment across both tables", () => {
    const listing = [
      '\t\tip daddr 169.254.169.254 counter packets 2 bytes 120 drop comment "metadata"',
      '\t\tip daddr 10.0.0.0/8 counter packets 3 bytes 180 drop comment "private"',
      '\t\tip daddr 192.168.0.0/16 counter packets 4 bytes 240 drop comment "private"',
      '\t\tcounter packets 5 bytes 300 drop comment "ipv6"',
    ].join("\n")
    expect(parseCounters(listing)).toEqual({ metadata: 2, private: 7, ipv6: 5 })
  })
})

describe("decide", () => {
  const plan = probePlan({ host: "1.1.1.1", port: 443 })
  const result = (reachable: (id: string) => boolean): CheckResult[] =>
    plan.map((p) => ({ id: p.id, reachable: reachable(p.id), detail: "x" }))
  const good: Observations = {
    before: result((id) => ["control", "metadata", "other-host", "other-port", "udp-dns"].includes(id)),
    after: result((id) => id === "control"),
    counters: { metadata: 2, ipv6: 5, "ipv6-link-local": 1 },
    agentFlushExit: 1,
    agentSudoExit: 1,
    sdkWorksAfter: true,
  }

  test("the plan covers every must-be-blocked id plus the control", () => {
    expect(plan.map((p) => p.id).sort()).toEqual(["control", ...MUST_BE_BLOCKED].sort())
  })

  test("all good is GO, and notes that the metadata check discriminates", () => {
    const v = decide(good)
    expect(v.go).toBe(true)
    expect(v.line).toContain("GO")
    expect(v.notes[0]).toContain("discriminates")
  })

  const nogo: [string, Partial<Observations>, RegExp][] = [
    ["metadata reachable after", { after: result((id) => id === "control" || id === "metadata") }, /metadata: reachable/],
    ["control blocked", { after: result(() => false) }, /control/],
    ["a check missing", { after: result((id) => id === "control").filter((r) => r.id !== "udp-dns") }, /udp-dns: not checked/],
    ["no metadata counter", { counters: { "ipv6-link-local": 1 } }, /metadata drop rule/],
    ["only the generic ipv6 counter", { counters: { metadata: 2, ipv6: 5 } }, /ipv6-link-local drop rule/],
    ["agent could flush", { agentFlushExit: 0 }, /could flush/],
    ["flush never ran", { agentFlushExit: 127 }, /proves nothing/],
    ["agent has sudo", { agentSudoExit: 0 }, /has sudo/],
    ["sdk broken", { sdkWorksAfter: false }, /SDK/],
  ]
  for (const [name, change, reason] of nogo) {
    test(`NO-GO when ${name}`, () => {
      const v = decide({ ...good, ...change })
      expect(v.go).toBe(false)
      expect(v.failures.join("\n")).toMatch(reason)
    })
  }
})

describe("supervisor metadata guard", () => {
  let server: net.Server
  afterAll(() => server?.close())

  test("a target that accepts a connection fails the guard", async () => {
    server = net.createServer((s) => s.end())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as net.AddressInfo).port
    const result = await checkUnreachable({ host: "127.0.0.1", port })
    expect(result.ok).toBe(false)
  })

  test("a refused connection passes", async () => {
    const probe = net.createServer()
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const port = (probe.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    expect((await checkUnreachable({ host: "127.0.0.1", port })).ok).toBe(true)
  })

  test("a timeout passes", async () => {
    // TEST-NET-1 is not routed; the connect hangs until the timeout.
    expect((await checkUnreachable({ host: "192.0.2.1", port: 80 }, 200)).ok).toBe(true)
  })
})
