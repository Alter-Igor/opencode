import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { generationProject, parseImageTag, readGenerations } from "../src/supervisor/generations.ts"
import { sessionIsIdle, sessionIsPending } from "../src/supervisor/relocate.ts"

const COMMITTED = "img:1.0.0-abcdef012345"
const DIRTY = "img:1.0.0-abcdef012345-dirty-0123456789ab"

describe("generation names", () => {
  test("a 12-hex committed tag names a second project", () => {
    expect(parseImageTag(COMMITTED)).toEqual({ version: "1.0.0", content: "abcdef012345" })
    expect(parseImageTag(`repo.example/box:${COMMITTED.slice("img:".length)}`)?.content).toBe("abcdef012345")
    expect(generationProject("opencode-delegate", COMMITTED)).toBe("opencode-delegate-abcdef012345")
  })

  test("a tag that is already this project stays on that project", () => {
    expect(generationProject("opencode-delegate-abcdef012345", COMMITTED)).toBe("opencode-delegate-abcdef012345")
  })

  test("a 7-hex fixture tag and a dirty tag do not name a project", () => {
    expect(parseImageTag("img:1.0.0-abcdef0")).toBeUndefined()
    expect(generationProject("opencode-delegate", "img:1.0.0-abcdef0")).toBeUndefined()
    expect(parseImageTag(DIRTY)?.dirty).toBe("0123456789ab")
    expect(generationProject("opencode-delegate", DIRTY)).toBeUndefined()
  })

  test("a name that would not fit the project rule is refused", () => {
    const base = `p${"a".repeat(27)}`
    expect(generationProject(base, COMMITTED)).toBeUndefined()
  })

  test("a damaged registry is an empty list", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "ocd-gen-"))
    await writeFile(path.join(home, "generations.json"), "{")
    expect(await readGenerations(home)).toEqual([])
    await writeFile(path.join(home, "generations.json"), JSON.stringify({ projects: ["opencode-delegate-abcdef012345", "Not Valid", 3] }))
    expect(await readGenerations(home)).toEqual(["opencode-delegate-abcdef012345"])
  })
})

describe("idle session", () => {
  test("idle means absent from the status object, and a pending list must be an array", () => {
    expect(sessionIsIdle({}, "ses_oldsession1")).toBe(true)
    expect(sessionIsIdle({ ses_oldsession1: { type: "busy" } }, "ses_oldsession1")).toBe(false)
    expect(sessionIsIdle([], "ses_oldsession1")).toBe(false)
    expect(sessionIsIdle(null, "ses_oldsession1")).toBe(false)
    expect(sessionIsPending([], "ses_oldsession1")).toBe(false)
    expect(sessionIsPending([{ sessionID: "ses_oldsession1" }], "ses_oldsession1")).toBe(true)
    expect(sessionIsPending({}, "ses_oldsession1")).toBe(true)
  })
})
