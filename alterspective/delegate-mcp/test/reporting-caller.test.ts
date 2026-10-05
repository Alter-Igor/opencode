// #132: which session delegated: the caller label, separate from the bridge name (the ownership key).
import { describe, expect, test } from "bun:test"
import { callerName } from "../src/reporting/caller.ts"
import { newTaskRecord } from "../src/reporting/record.ts"

describe("callerName", () => {
  test("OPENCODE_DELEGATE_CALLER wins over the working directory", () => {
    expect(callerName({ OPENCODE_DELEGATE_CALLER: "my-session" }, "/home/me/project")).toBe("my-session")
  })

  test("an empty or blank variable falls back to the folder name", () => {
    expect(callerName({ OPENCODE_DELEGATE_CALLER: "" }, "/home/me/project")).toBe("project")
    expect(callerName({ OPENCODE_DELEGATE_CALLER: "   " }, "/home/me/project")).toBe("project")
  })

  test("the last folder name of a POSIX or Windows path, with or without a trailing separator", () => {
    expect(callerName({}, "/home/me/project")).toBe("project")
    expect(callerName({}, "/home/me/project/")).toBe("project")
    expect(callerName({}, "C:\\GitHub\\demo-repo")).toBe("demo-repo")
    expect(callerName({}, "C:\\GitHub\\demo-repo\\")).toBe("demo-repo")
    expect(callerName({}, "C:/GitHub/demo-repo")).toBe("demo-repo")
  })

  test("a drive root is returned as it is", () => {
    expect(callerName({}, "C:\\")).toBe("C:\\")
    expect(callerName({}, "D:")).toBe("D:")
    expect(callerName({}, "/")).toBe("/")
  })

  test("nothing usable gives (unknown)", () => {
    expect(callerName({}, "")).toBe("(unknown)")
    expect(callerName({}, "   ")).toBe("(unknown)")
    expect(callerName({ OPENCODE_DELEGATE_CALLER: " " }, "")).toBe("(unknown)")
  })

  test("trimmed and cut to 128 characters", () => {
    expect(callerName({ OPENCODE_DELEGATE_CALLER: "  padded  " }, "/x")).toBe("padded")
    expect(callerName({ OPENCODE_DELEGATE_CALLER: "y".repeat(300) }, "/x")).toHaveLength(128)
    expect(callerName({}, `/a/${"z".repeat(300)}`)).toHaveLength(128)
  })

  test("control characters become spaces, so the record keeps the label (review: CodeRabbit on #135)", () => {
    expect(callerName({ OPENCODE_DELEGATE_CALLER: "team\tA\nlaptop" }, "/x")).toBe("team A laptop")
    expect(callerName({ OPENCODE_DELEGATE_CALLER: "\t\n" }, "/a/project")).toBe("project")
    const record = newTaskRecord({ sessionID: "ses_abcdefgh", key: "s-1", bridge: "b", repo: "r", startedAt: "2026-10-05T00:00:00.000Z", caller: callerName({ OPENCODE_DELEGATE_CALLER: "x\ty" }, "/x") })
    expect(record.caller).toBe("x y")
  })

  test("defaults to the process environment and working directory", () => {
    expect(callerName().length).toBeGreaterThan(0)
  })
})
