import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { FRONT_GENERATIONS, FRONT_GENERATION_URL, KS_AUTH_LIST, readFrontGeneration } from "../src/supervisor/front-generation.ts"
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

describe("the running front generation with Keystone includes (#67 step 3)", () => {
  const KS = { "rag-read": "ks rag\n", github: "ks github\n" }

  test("a fourth hash names the ks-auth.list; each include is read and verified against it", async () => {
    const generation = await readFrontGeneration(generationExec("servers\n", "auth\n", undefined, KS), "front")
    expect(generation).toEqual({ servers: "servers\n", auth: "auth\n", keystone: [{ id: "github", text: "ks github\n" }, { id: "rag-read", text: "ks rag\n" }] })
  })

  test("the three-hash reply (flag off) still parses, with no keystone field", async () => {
    const generation = await readFrontGeneration(generationExec("servers\n", "auth\n"), "front")
    expect(generation).toEqual({ servers: "servers\n", auth: "auth\n" })
    expect(generation && "keystone" in generation).toBe(false)
  })

  test("a changed include, a changed or malformed list, or a missing include fails closed", async () => {
    const exec = generationExec("servers\n", "auth\n", undefined, KS)
    const swap = (suffix: string, stdout: string, code = 0) => async (args: string[]) => (args.at(-1)?.endsWith(suffix) ? { code, stdout, stderr: "" } : exec(args))
    expect(await readFrontGeneration(swap("/ks-auth-github.conf", "changed\n"), "front")).toBeUndefined()
    expect(await readFrontGeneration(swap("/ks-auth-github.conf", "", 1), "front")).toBeUndefined()
    expect(await readFrontGeneration(swap(`/${KS_AUTH_LIST}`, "ks-auth-github.conf 00\n"), "front")).toBeUndefined()
    // A list whose own hash matches but names a bad id or path is still refused.
    for (const list of [`ks-auth-../x.conf ${"a".repeat(64)}\n`, `../synapse-auth.conf ${"a".repeat(64)}\n`, "", `ks-auth-a.conf ${"a".repeat(64)}`]) {
      const forged = generationExec("servers\n", "auth\n")
      const marker = `${"1".repeat(32)} ${[ "servers\n", "auth\n", list].map(sha).join(" ")}`
      const dir = `${FRONT_GENERATIONS}/${["servers\n", "auth\n", list].map(sha).join("-")}`
      const exec2 = async (args: string[]) => {
        if (args.includes(FRONT_GENERATION_URL)) return { code: 0, stdout: marker, stderr: "" }
        if (args.at(-1) === `${dir}/source-servers.conf`) return { code: 0, stdout: "servers\n", stderr: "" }
        if (args.at(-1) === `${dir}/synapse-auth.conf`) return { code: 0, stdout: "auth\n", stderr: "" }
        if (args.at(-1) === `${dir}/${KS_AUTH_LIST}`) return { code: 0, stdout: list, stderr: "" }
        return forged(args)
      }
      expect({ list, generation: await readFrontGeneration(exec2, "front") }).toEqual({ list, generation: undefined })
    }
  })

  test("a five-field or malformed fourth hash is never loaded", async () => {
    const h = "a".repeat(64)
    for (const marker of [`${"1".repeat(32)} ${h} ${h} ${h} ${h}`, `${"1".repeat(32)} ${h} ${h} ${"g".repeat(64)}`, `${"1".repeat(32)} ${h} ${h} `])
      expect(await readFrontGeneration(generationExec("servers", "auth", marker, KS), "front")).toBeUndefined()
  })
})

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
