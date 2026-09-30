import { describe, expect, test } from "bun:test"
import { runCommand } from "../src/supervisor/workspaces-exec.ts"

// Real processes, not fakes: the fake box in the other tests never reproduced how Node's
// execFile reports a plain non-zero exit (found live: boxExists misread "absent" as a failure).
describe("runCommand", () => {
  const node = process.execPath

  test("a plain non-zero exit keeps its code and an empty stderr", async () => {
    const result = await runCommand([node, "-e", "process.exit(1)"], process.env, 30_000)
    expect(result.code).toBe(1)
    expect(result.stderr).toBe("")
  })

  test("real stderr is passed through on failure", async () => {
    const result = await runCommand([node, "-e", "console.error('boom'); process.exit(3)"], process.env, 30_000)
    expect(result.code).toBe(3)
    expect(result.stderr.trim()).toBe("boom")
  })

  test("success returns stdout and code 0", async () => {
    const result = await runCommand([node, "-e", "process.stdout.write('ok')"], process.env, 30_000)
    expect(result).toMatchObject({ code: 0, stdout: "ok", stderr: "" })
  })

  test("a program that cannot start reports 127 with a reason", async () => {
    const result = await runCommand(["definitely-not-a-real-binary-ocd"], process.env, 30_000)
    expect(result.code).toBe(127)
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})
