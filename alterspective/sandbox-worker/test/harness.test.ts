import { describe, expect, test } from "bun:test"
import {
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  classify,
  freezeSucceeded,
  exitCodeFor,
  harnessEnv,
  parseHarnessRequest,
  pathsToCheck,
  readTail,
  tail,
  type HarnessOutcome,
} from "../supervisor/harness"

// #121: the harness check. All inputs come from the service, never from the box.

const valid = {
  taskId: "task-42",
  archive: "/var/lib/sbxw-harness/in/tests.tar.gz",
  sha256: "a".repeat(64),
  command: ["bun", "test", "hidden"],
  agentClaim: "GOAL_MET",
}

describe("parseHarnessRequest", () => {
  test("fills the defaults", () => {
    const parsed = parseHarnessRequest(valid)
    expect(parsed).toEqual({
      ok: true,
      request: {
        ...valid,
        extractTo: ".",
        timeoutSec: DEFAULT_TIMEOUT_SEC,
        repoDir: "/work/repo",
        freezeAgent: true,
      },
    })
  })

  test("keeps explicit values and lower-cases the hash", () => {
    const parsed = parseHarnessRequest({ ...valid, sha256: "A".repeat(64), extractTo: "hidden_tests", timeoutSec: 30, freezeAgent: false })
    expect(parsed.ok && parsed.request).toMatchObject({ sha256: "a".repeat(64), extractTo: "hidden_tests", timeoutSec: 30, freezeAgent: false })
  })

  const bad: [string, Record<string, unknown> | unknown][] = [
    ["not an object", "x"],
    ["an array", []],
    ["no taskId", { ...valid, taskId: undefined }],
    ["an unsafe taskId", { ...valid, taskId: "../etc" }],
    ["a relative archive", { ...valid, archive: "tests.tar" }],
    ["a short sha256", { ...valid, sha256: "abc" }],
    ["extractTo escaping the repo", { ...valid, extractTo: "../outside" }],
    ["an absolute extractTo", { ...valid, extractTo: "/etc" }],
    ["a string command", { ...valid, command: "bun test" }],
    ["an empty command", { ...valid, command: [] }],
    ["an empty command part", { ...valid, command: ["bun", ""] }],
    ["a zero timeout", { ...valid, timeoutSec: 0 }],
    ["a timeout over the cap", { ...valid, timeoutSec: MAX_TIMEOUT_SEC + 1 }],
    ["a fractional timeout", { ...valid, timeoutSec: 1.5 }],
    ["no agentClaim", { ...valid, agentClaim: undefined }],
    ["a relative repoDir", { ...valid, repoDir: "work/repo" }],
    ["a string freezeAgent", { ...valid, freezeAgent: "yes" }],
  ]
  for (const [name, input] of bad) {
    test(`refuses ${name}`, () => {
      expect(parseHarnessRequest(input).ok).toBe(false)
    })
  }
})

describe("classify: the agent's claim and the tests are reported apart", () => {
  const passed: HarnessOutcome = { ran: true, passed: true, exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "" }
  const failed: HarnessOutcome = { ...passed, passed: false, exitCode: 1 }
  const error: HarnessOutcome = { ran: false, error: "tests archive SHA-256 mismatch" }

  test("GOAL_MET and the tests pass: claim-confirmed", () => expect(classify("GOAL_MET", passed)).toBe("claim-confirmed"))
  test("GOAL_MET but the tests fail: claim-refuted", () => expect(classify("GOAL_MET", failed)).toBe("claim-refuted"))
  test("claim spelling is forgiving on case and spaces", () => expect(classify(" goal_met ", failed)).toBe("claim-refuted"))
  test("no claim and the tests pass: unclaimed-pass", () => expect(classify("NOT_MET", passed)).toBe("unclaimed-pass"))
  test("no claim and the tests fail: unclaimed-fail", () => expect(classify("", failed)).toBe("unclaimed-fail"))
  test("a harness error is never a pass", () => {
    expect(classify("GOAL_MET", error)).toBe("harness-error")
    expect(exitCodeFor("harness-error", error)).toBe(2)
  })
  test("a timeout is a harness error, never claim-refuted", () => {
    const timedOut: HarnessOutcome = { ...failed, exitCode: null, timedOut: true }
    expect(classify("GOAL_MET", timedOut)).toBe("harness-error")
    expect(exitCodeFor(classify("GOAL_MET", timedOut), timedOut)).toBe(2)
  })
  test("exit codes: 0 passed, 1 failed", () => {
    expect(exitCodeFor("claim-confirmed", passed)).toBe(0)
    expect(exitCodeFor("claim-refuted", failed)).toBe(1)
  })
})

describe("freezeSucceeded", () => {
  test("signalled or nothing to freeze is fine", () => {
    expect(freezeSucceeded(0)).toBe(true)
    expect(freezeSucceeded(1)).toBe(true)
  })
  test("an error or a missing pkill fails closed", () => {
    for (const code of [2, 3, 127, -1]) expect(freezeSucceeded(code)).toBe(false)
  })
})

describe("harnessEnv and tail", () => {
  test("the test environment carries nothing from the box", () => {
    const env = harnessEnv("/var/lib/sbxw-harness/run-x")
    expect(Object.keys(env).sort()).toEqual(["CI", "HOME", "LANG", "PATH"])
    expect(JSON.stringify(env)).not.toMatch(/SBXW_|KEY|TOKEN|PASSWORD/)
  })

  test("readTail keeps only the end of a long stream", async () => {
    const chunks = Array.from({ length: 50 }, (_, i) => `line-${i};`)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
        controller.close()
      },
    })
    const all = chunks.join("")
    expect(await readTail(stream, 20)).toBe("…" + all.slice(-20))
  })

  test("readTail returns a short stream unchanged", async () => {
    expect(await readTail(new Response("hello").body!, 20)).toBe("hello")
  })

  test("tail keeps the end of a long log", () => {
    expect(tail("short")).toBe("short")
    const long = "x".repeat(20) + "END"
    expect(tail(long, 5)).toBe("…" + long.slice(-5))
  })
})

describe("pathsToCheck: every place the tests get written", () => {
  test("covers extractTo and every folder and file of each member", () => {
    expect(pathsToCheck("a/b", ["hidden/", "hidden/x.test.ts"])).toEqual({
      ok: true,
      paths: ["a", "a/b", "a/b/hidden", "a/b/hidden/x.test.ts"],
    })
  })
  test("the repo root itself is not a path to check", () => {
    expect(pathsToCheck(".", ["./hidden/x.test.ts", ""])).toEqual({ ok: true, paths: ["hidden", "hidden/x.test.ts"] })
  })
  test("refuses members that escape the repo", () => {
    expect(pathsToCheck(".", ["../x"]).ok).toBe(false)
    expect(pathsToCheck(".", ["/etc/x"]).ok).toBe(false)
    expect(pathsToCheck(".", ["a/../../x"]).ok).toBe(false)
  })
})
