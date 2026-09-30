// T2.3 — egress allowlist generated from config.egressHosts (technical-design §1, review N3).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { egressAllowlist } from "../src/guard/egress.ts"
import { defaultConfig } from "../src/shared/config.ts"

const EGRESS_DIR = path.join(import.meta.dir, "..", "docker", "egress")

// tinyproxy compiles each line as a POSIX ERE with REG_ICASE (FilterCaseSensitive defaults off).
// For the subset the generator emits (^, $, \.) JS RegExp semantics are identical.
function allows(list: string, host: string): boolean {
  return list
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .some((line) => new RegExp(line, "i").test(host))
}

describe("egressAllowlist", () => {
  const list = egressAllowlist(["identity.alterspective.com.au", "synapse2-api.alterspective.com.au"])

  test("one exact-host anchored line per host, dots escaped", () => {
    const lines = list.split("\n").filter((l) => l && !l.startsWith("#"))
    expect(lines).toEqual(["^identity\\.alterspective\\.com\\.au$", "^synapse2-api\\.alterspective\\.com\\.au$"])
  })

  test("allows the listed hosts", () => {
    expect(allows(list, "identity.alterspective.com.au")).toBe(true)
    expect(allows(list, "synapse2-api.alterspective.com.au")).toBe(true)
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

  test("tinyproxy.conf: default deny, CONNECT to 443 only, host (not URL) filter", () => {
    const conf = readFileSync(path.join(EGRESS_DIR, "tinyproxy.conf"), "utf8")
    const directives = conf.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"))
    expect(directives).toContain("FilterDefaultDeny Yes")
    expect(directives).toContain("FilterType ere")
    expect(directives).toContain("FilterURLs Off")
    expect(directives.filter((l) => l.startsWith("ConnectPort"))).toEqual(["ConnectPort 443"])
    expect(directives.some((l) => l.startsWith("FilterCaseSensitive"))).toBe(false)
    expect(directives.some((l) => /^Upstream/.test(l))).toBe(false)
  })
})
