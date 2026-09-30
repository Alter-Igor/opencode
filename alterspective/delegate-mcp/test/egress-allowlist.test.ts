// T2.3 — egress allowlist generated from config.egressHosts (technical-design §1, review N3).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { egressAllowlist } from "../src/guard/egress.ts"
import { defaultConfig } from "../src/shared/config.ts"

const EGRESS_DIR = path.join(import.meta.dir, "..", "docker", "egress")

// tinyproxy compiles each line as a POSIX ERE with REG_ICASE (FilterCaseSensitive defaults off).
// For the subset the generator emits (^, $, \., :) JS RegExp semantics are identical.
// With `FilterURLs On` the string tested is the request URL: `host:443` for CONNECT,
// `http://host/...` for plain HTTP (observed in the tinyproxy log; proven in egress-live.test.ts).
function matches(list: string, url: string): boolean {
  return list
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .some((line) => new RegExp(line, "i").test(url))
}
const allows = (list: string, host: string) => matches(list, `${host}:443`)

describe("egressAllowlist", () => {
  const list = egressAllowlist(["identity.alterspective.com.au", "synapse2-api.alterspective.com.au"])

  test("one exact host:443 anchored line per host, dots escaped", () => {
    const lines = list.split("\n").filter((l) => l && !l.startsWith("#"))
    expect(lines).toEqual(["^identity\\.alterspective\\.com\\.au:443$", "^synapse2-api\\.alterspective\\.com\\.au:443$"])
  })

  test("allows the listed hosts", () => {
    expect(allows(list, "identity.alterspective.com.au")).toBe(true)
    expect(allows(list, "synapse2-api.alterspective.com.au")).toBe(true)
  })

  test("plain-HTTP URLs never match, even for an allowed host (C-5)", () => {
    for (const url of [
      "http://identity.alterspective.com.au/",
      "http://identity.alterspective.com.au:443/",
      "http://identity.alterspective.com.au:443identity.alterspective.com.au:443",
      "identity.alterspective.com.au:80",
      "identity.alterspective.com.au:4430",
      "identity.alterspective.com.au.:443",
      "http://example.com/",
    ]) {
      expect({ url, allowed: matches(list, url) }).toEqual({ url, allowed: false })
    }
  })

  const refused = [
    "identity.alterspective.com.au.evil.com",
    "evilidentity.alterspective.com.au",
    "x.identity.alterspective.com.au",
    "identityXalterspective.com.au",
    "identity.alterspectiveXcom.au",
    "rag.alterspective.com.au",
    "registry.npmjs.org",
    "pypi.org",
    "upload.pypi.org",
    "",
  ]
  for (const host of refused) {
    test(`does not match ${JSON.stringify(host)}`, () => expect(allows(list, host)).toBe(false))
  }

  const invalid: Array<[string, string[]]> = [
    ["empty list", []],
    ["wildcard", ["*.alterspective.com.au"]],
    ["regex characters", ["identity.alterspective.com.au|.*"]],
    ["port", ["identity.alterspective.com.au:443"]],
    ["scheme", ["https://identity.alterspective.com.au"]],
    ["single label", ["localhost"]],
    ["whitespace", ["identity.alterspective.com.au\n.*"]],
    ["npm registry (publish route, N3)", ["registry.npmjs.org"]],
    ["PyPI upload (publish route, N3)", ["upload.pypi.org"]],
    ["PyPI (N3)", ["pypi.org"]],
    ["IPv4 literal", ["10.0.0.1"]],
    ["IPv4 with numeric last label", ["example.123"]],
    ["hex last label", ["example.0x7f"]],
    ["all-numeric label", ["163.example.com"]],
    ["IPv6 literal", ["::1"]],
    ["bracketed IPv6", ["[2001:db8::1]"]],
  ]
  for (const [label, hosts] of invalid) {
    test(`refuses ${label}`, () => expect(() => egressAllowlist(hosts)).toThrow())
  }

  test("normalises case and drops duplicates", () => {
    expect(egressAllowlist(["Identity.Alterspective.com.au", "identity.alterspective.com.au"])).toBe(
      egressAllowlist(["identity.alterspective.com.au"]),
    )
  })
})

describe("committed egress files", () => {
  test("docker/egress/allow.txt is the generated allowlist for the default config (no drift)", () => {
    const committed = readFileSync(path.join(EGRESS_DIR, "allow.txt"), "utf8").replaceAll("\r\n", "\n")
    expect(committed).toBe(egressAllowlist(defaultConfig({}).egressHosts))
  })

  test("tinyproxy.conf: default deny, CONNECT to 443 only, URL filter (plain HTTP never matches)", () => {
    const conf = readFileSync(path.join(EGRESS_DIR, "tinyproxy.conf"), "utf8")
    const directives = conf.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"))
    expect(directives).toContain("FilterDefaultDeny Yes")
    expect(directives).toContain("FilterType ere")
    expect(directives).toContain("FilterURLs On")
    expect(directives.filter((l) => l.startsWith("ConnectPort"))).toEqual(["ConnectPort 443"])
    expect(directives.some((l) => l.startsWith("FilterCaseSensitive"))).toBe(false)
    expect(directives.some((l) => /^Upstream/.test(l))).toBe(false)
  })
})
