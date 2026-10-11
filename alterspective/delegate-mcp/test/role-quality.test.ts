// The role-quality guard: comparing a published suitability table against measured outcomes.
// Pure over inputs (no clock, no network, no disk here) plus the CLI wiring; the runner's
// unreadable-table path is exercised with a tokenless temp home (no network, no sandbox start).
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { qualityReport } from "../src/reporting/role-quality.ts"
import { EXIT, parseCli, runRoleQuality } from "../src/cli.ts"
import type { Runtime } from "../src/runtime.ts"
import { fakeContext } from "./tools-core-fixture.ts"

const table = {
  "openai/gpt-6-astra": { code: 1, general: 1 },
  "claude-opus-5": { code: 1, general: 1 },
  "ornith-1.0-35b": { code: 1 },
  "qwen3.8-27b-dflash2": { code: 0.96 },
}
const rates = [
  { model: "openai/gpt-6-astra", successRate: 0.93, tasks: 143 },
  { model: "ornith-1.0-35b", successRate: 0.52, tasks: 15 },
  { model: "qwen3.8-27b-dflash2", successRate: 0.86, tasks: 59 },
]
const offered = ["auto", "openai/gpt-6-astra", "claude-opus-5", "ornith-1.0-35b", "qwen3.8-27b-dflash2"]

describe("qualityReport", () => {
  test("no table: nothing to compare, not baked (keep the tie-break)", () => {
    expect(qualityReport(undefined, rates, [], offered)).toEqual({ roles: [], allBaked: false, deadInTable: [] })
  })

  test("dead ghost is the published top: role is not baked and the ghost is named", () => {
    const r = qualityReport(table, rates, ["claude-opus-5"], offered)
    const code = r.roles.find((v) => v.role === "code")
    expect(code?.published?.model).toBe("claude-opus-5")
    expect(code?.baked).toBe(false)
    expect(code?.reason).toContain("dead route")
    expect(r.deadInTable).toEqual(["claude-opus-5"])
    expect(r.allBaked).toBe(false)
  })

  test("alive published pick far below the measured best: not baked, the gap is in the reason", () => {
    // ornith wins the published table outright but measures 52% against astra's 93%.
    const worse = { "ornith-1.0-35b": { code: 1 }, "openai/gpt-6-astra": { code: 0.99 }, "qwen3.8-27b-dflash2": { code: 0.96 } }
    const code = qualityReport(worse, rates, [], offered).roles.find((v) => v.role === "code")
    expect(code?.published?.model).toBe("ornith-1.0-35b")
    expect(code?.baked).toBe(false)
    expect(code?.reason).toContain("gap")
  })

  test("baked: published pick is alive and within tolerance of the measured best (tol default 0.1)", () => {
    const good = { "openai/gpt-6-astra": { code: 1 }, "zai/other": { code: 0.9 } }
    const rr = qualityReport(good, rates, [], ["openai/gpt-6-astra", "zai/other"])
    const code = rr.roles.find((v) => v.role === "code")
    expect(code?.baked).toBe(true)
    expect(code?.reason).toContain("93%")
    expect(rr.allBaked).toBe(true)
    expect(rr.deadInTable).toEqual([])
  })

  test("published pick with too little history is not baked; the measured best needs 5+ finished", () => {
    const sparse = { "rare/model": { code: 1 }, "openai/gpt-6-astra": { code: 0.5 } }
    const v = qualityReport(sparse, [...rates, { model: "rare/model", successRate: 1, tasks: 2 }], [], ["rare/model", "openai/gpt-6-astra"]).roles[0]!
    expect(v.baked).toBe(false)
    expect(v.reason).toContain("too little measured history")
    const none = qualityReport(sparse, [], [], ["rare/model", "openai/gpt-6-astra"]).roles[0]!
    expect(none.reason).toContain("no measured rate")
  })

  test("a model outside the offered set is never the published pick (box-offer constraint)", () => {
    const withForeign = { "cloud/retired": { code: 1 }, "openai/gpt-6-astra": { code: 0.9 } }
    const v = qualityReport(withForeign, rates, [], ["openai/gpt-6-astra"]).roles[0]!
    expect(v.published?.model).toBe("openai/gpt-6-astra")
    expect(v.baked).toBe(true)
  })

  test("a published pick that never appears in our rates at all is not baked", () => {
    const v = qualityReport({ "new/model": { code: 1 }, "openai/gpt-6-astra": { code: 0.9 } }, rates, [], ["new/model", "openai/gpt-6-astra"]).roles[0]!
    expect(v.published?.model).toBe("new/model")
    expect(v.measured?.model).toBe("openai/gpt-6-astra") // the only candidate with history
    expect(v.baked).toBe(false)
    expect(v.reason).toContain("too little measured history")
  })

  test("allBaked refuses while a dead route is still published in the table, even if every role's own top pick is baked", () => {
    // the ghost scores below the top everywhere, so no role names it - but it is still a dead row
    // in the gateway's table, which vetoes the whole table as the sole signal.
    const withGhost = { "openai/gpt-6-astra": { code: 1, general: 1 }, "claude-opus-5": { code: 0.5, general: 0.5 } }
    const r = qualityReport(withGhost, rates, ["claude-opus-5"], ["openai/gpt-6-astra", "claude-opus-5"])
    expect(r.roles.every((v) => v.baked)).toBe(true)
    expect(r.deadInTable).toEqual(["claude-opus-5"])
    expect(r.allBaked).toBe(false)
  })
})

describe("cli role-quality", () => {
  test("parse: plain and --json, bad flags refused", () => {
    expect(parseCli(["role-quality"])).toEqual({ kind: "role-quality", days: 30, json: false })
    expect(parseCli(["role-quality", "--json"])).toEqual({ kind: "role-quality", days: 30, json: true })
    expect(parseCli(["role-quality", "--bogus"]).kind).toBe("error")
  })

  test("no host token: prints the keep-the-tie-break line, exit 0, never starts the box, never hits the network", async () => {
    const f = fakeContext()
    f.ctx.config.home = await mkdtemp(path.join(os.tmpdir(), "ocd-rq-"))
    const lines: string[] = []
    try {
      const code = await runRoleQuality({ out: (t) => lines.push(t), err: () => {} }, 30, false, async () => ({ ctx: f.ctx, versionInfo: { version: "v", package: "0", sha: "x", dirty: false, built: null }, name: "t", shutdown: async () => {} }) as unknown as Runtime)
      expect(code).toBe(EXIT.ok)
      expect(lines.join("\n")).toContain("no live table")
      expect(lines.join("\n")).toContain("keep the tie-break")
      expect(f.started.count).toBe(0)
      expect(f.boxCmds).toEqual([])
    } finally {
      await rm(f.ctx.config.home, { recursive: true, force: true })
    }
  })
})

