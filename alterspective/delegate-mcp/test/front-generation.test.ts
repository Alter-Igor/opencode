import { describe, expect, test } from "bun:test"
import { FRONT_GENERATION_URL, readFrontGeneration } from "../src/supervisor/front-generation.ts"
import { generationExec } from "./front-generation-fixture.ts"

describe("the running front generation", () => {
  test("uses a worker response and verifies both immutable file hashes", async () => {
    expect(await readFrontGeneration(generationExec("servers\n", "auth\n"), "front")).toEqual({ servers: "servers\n", auth: "auth\n" })
  })

  test("a marker alone is not enough: absent or changed immutable files fail closed", async () => {
    const exec = generationExec("servers\n", "auth\n")
    expect(await readFrontGeneration(async (args) => args.at(-1)?.endsWith("/synapse-auth.conf") ? { code: 0, stdout: "changed\n", stderr: "" } : exec(args), "front")).toBeUndefined()
    expect(await readFrontGeneration(async (args) => args.at(-1)?.endsWith("/source-servers.conf") ? { code: 1, stdout: "", stderr: "missing" } : exec(args), "front")).toBeUndefined()
  })

  test("no worker response, bad hash shape or trailing data is never loaded", async () => {
    for (const marker of ["", "not-a-hash", `${"a".repeat(64)} ${"b".repeat(64)} extra`, `../escape ${"b".repeat(64)}`])
      expect(await readFrontGeneration(generationExec("servers", "auth", marker), "front")).toBeUndefined()
    const exec = generationExec("servers", "auth")
    expect(await readFrontGeneration(async (args) => args.includes(FRONT_GENERATION_URL) ? { code: 1, stdout: "", stderr: "timeout" } : exec(args), "front")).toBeUndefined()
  })
})
