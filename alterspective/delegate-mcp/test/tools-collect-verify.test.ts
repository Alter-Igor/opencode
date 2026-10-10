// D6 (owner decision 2026-10-10): oc_collect verify runs allowlisted commands in the box
// workspace and reports the exit codes the BRIDGE observed - the agent's "tests passed" claim is
// replaced by evidence. A failing verify still fetches the branch, loudly marked.
import { describe, expect, test } from "bun:test"
import { collectTool } from "../src/tools/collect.ts"
import { SID, data, fakeContext, invoke, okCmd, record, text, type Fake } from "./tools-core-fixture.ts"

const collect = (f: Fake, args: Record<string, unknown> = {}) => invoke(collectTool, { sessionID: SID, ...args }, f.ctx)

function seeded(f: Fake) {
  f.ctx.sessions.set(SID, record())
}

describe("oc_collect verify (D6)", () => {
  test("a passing verify reports bridge-observed exit codes and runs in the session workspace", async () => {
    const f = fakeContext()
    seeded(f)
    const result = await collect(f, { verify: ["bun install", "bun test"] })
    const verify = data(result).verify as { passed: boolean; rows: Array<{ command: string; exitCode: number }> }
    expect(verify.passed).toBe(true)
    expect(verify.rows.map((r) => [r.command, r.exitCode])).toEqual([["bun install", 0], ["bun test", 0]])
    expect(f.boxCwds).toEqual(["/sessions/s-0000000001", "/sessions/s-0000000001"]) // the box workspace, never the host tree
    expect(f.boxCmds[0]?.[0]).toBe("bun")
    expect(text(result)).toContain("Verification: 2 command(s) passed")
  })

  test("a failing verify still fetches the branch and calls the agent's claim unproven", async () => {
    const f = fakeContext()
    seeded(f)
    f.setBox((argv) => (argv[1] === "test" ? { code: 1, stdout: "10 failures", stderr: "" } : okCmd()))
    const result = await collect(f, { verify: ["bun test"] })
    expect(result.isError).toBeUndefined()
    expect(data(result).commits).toBe(1) // branch fetched either way
    expect(data(result).verify).toMatchObject({ passed: false })
    expect(text(result)).toContain("VERIFICATION FAILED")
    expect(text(result)).toContain("exit 1")
    expect(text(result)).toContain("unproven")
    const row = (data(result).verify as { rows: Array<{ stdout: { text: string } }> }).rows[0]
    expect(row?.stdout.text).toBe("10 failures")
  })

  test("a command outside the verify allowlist refuses the whole collect before anything runs", async () => {
    const f = fakeContext()
    seeded(f)
    const result = await collect(f, { verify: ["bun test", "rm -rf /"] })
    expect(data(result).code).toBe("policy_violation")
    expect(f.collected).toEqual([]) // refused before the fetch
    expect(f.boxCmds).toEqual([])
  })

  test("shell metacharacters are refused the same way (same policy as oc_verify/oc_land)", async () => {
    const f = fakeContext()
    seeded(f)
    const result = await collect(f, { verify: ["bun test; echo done"] })
    expect(data(result).code).toBe("invalid_input")
    expect(f.collected).toEqual([])
  })

  test("no verify requested: no box commands, no verify field (the fetch stands alone)", async () => {
    const f = fakeContext()
    seeded(f)
    const result = await collect(f)
    expect(data(result).verify).toBeUndefined()
    expect(f.boxCmds).toEqual([])
  })
})
