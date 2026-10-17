import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { mcpAllowPolicy } from "../src/shared/config.ts"
import { SILENT_BOX_WAIT_MS, SILENT_GAP_MS } from "../src/supervisor/lifecycle.ts"
import { planFor } from "../src/supervisor/plan.ts"
import { readHostState, writeHostState } from "../src/supervisor/workspaces-state.ts"
import { L, deps, fail, fakeDocker, home, leaseDir, recorder, supervisor, writeOwner, type Box, type Call, useSupervisorFixture } from "./supervisor-lifecycle-fixture.ts"

useSupervisorFixture()

const IMAGE = "img:1.0.0-abcdef012345"
const NEXT = "opencode-delegate-abcdef012345"
const DIRTY = "img:1.0.0-abcdef012345-dirty-0123456789ab"
const BASE = "a".repeat(40)
const CALLER = "ses_oldsession1"
const MOVED = "ses_moved0001"

function oldBox(): Box {
  return {
    running: true,
    labels: { [L.hash]: "old", [L.port]: "4711", [L.image]: "img:0.9.0-1111111", [L.front]: "old" },
    env: ["OPENCODE_SERVER_PASSWORD=x", "OPENCODE_MCP_ALLOW={}"],
  }
}

function record(boxProject = "opencode-delegate") {
  writeHostState(path.join(home, "workspaces"), {
    sessionKey: "idle-key",
    hostRepo: "C:\\GitHub\\demo",
    base: BASE,
    createdAt: new Date(0).toISOString(),
    sessionID: CALLER,
    supervisor: "supervisor:test",
    profile: "standard",
    boxProject,
  })
}

function fetchFor(status: unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/session/status")) return Response.json(status)
    if (url.includes("/permission")) return Response.json([])
    if (url.includes("/question")) return Response.json([])
    if ((init?.method ?? "GET") === "POST" && url.includes("/session")) return Response.json({ id: MOVED })
    return new Response("", { status: 200 })
  }) as typeof fetch
}

const downOf = (calls: Call[], project: string) => calls.filter((call) => call.argv.includes("down") && call.argv[call.argv.indexOf("-p") + 1] === project)

describe("supervisor generations (#171)", () => {
  test("a committed image starts a second project and does not stop a box that still has a lease", async () => {
    await writeOwner()
    await mkdir(leaseDir(), { recursive: true })
    await writeFile(path.join(leaseDir(), "bridge-old"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + "\n")
    record()
    const calls: Call[] = []
    const sup = supervisor(deps(fakeDocker(oldBox(), calls), { image: IMAGE, fetch: fetchFor({}) }))
    await sup.ensure()
    const up = calls.find((call) => call.argv.includes("up"))!
    expect(up.argv[up.argv.indexOf("-p") + 1]).toBe(NEXT)
    expect(up.env!.OCD_CONTAINER).toBe(NEXT)
    expect(up.env!.OCD_FRONT_DIR).toBe(path.join(home, "generations", NEXT, "front"))
    expect(up.env!.OCD_PROFILE_DIR).toBe(path.join(home, "generations", NEXT, "profile"))
    expect(existsSync(path.join(home, "front"))).toBe(false)
    expect(existsSync(path.join(home, "generations", NEXT, "front", "servers.conf"))).toBe(true)
    expect(calls.some((call) => call.argv.includes("down"))).toBe(false)
    expect(calls.some((call) => call.argv[1] === "cp")).toBe(false)
    const state = readHostState(path.join(home, "workspaces"), "idle-key")
    expect(state?.sessionID).toBe(CALLER)
    expect(state?.boxSessionID).toBeUndefined()
    expect(state?.boxProject).toBe("opencode-delegate")
  })

  test("an idle session with no lease is copied, keeps its caller id, and the empty old project stops", async () => {
    await writeOwner()
    record()
    const calls: Call[] = []
    await supervisor(deps(fakeDocker(oldBox(), calls), { image: IMAGE, fetch: fetchFor({}) })).ensure()
    const copies = calls.filter((call) => call.argv[1] === "cp")
    expect(copies.map((call) => call.argv[2])).toContain(`opencode-delegate:/sessions/idle-key`)
    expect(copies.some((call) => call.argv[3] === `${NEXT}:/sessions/idle-key`)).toBe(true)
    const state = readHostState(path.join(home, "workspaces"), "idle-key")
    expect(state?.sessionID).toBe(CALLER)
    expect(state?.boxSessionID).toBe(MOVED)
    expect(state?.boxProject).toBe(NEXT)
    const down = downOf(calls, "opencode-delegate")
    expect(down).toHaveLength(1)
    expect(down[0]!.argv).not.toContain("-v")
    expect(down[0]!.argv).not.toContain("--volumes")
    expect(downOf(calls, NEXT)).toHaveLength(0)
    const upAt = calls.findIndex((call) => call.argv.includes("up"))
    const downAt = calls.findIndex((call) => call.argv.includes("down"))
    expect(upAt).toBeGreaterThanOrEqual(0)
    expect(downAt).toBeGreaterThan(upAt)
  })

  test("a busy session stays on the old project and that project stays up", async () => {
    await writeOwner()
    record()
    const calls: Call[] = []
    await supervisor(deps(fakeDocker(oldBox(), calls), { image: IMAGE, fetch: fetchFor({ [CALLER]: { type: "busy" } }) })).ensure()
    expect(calls.some((call) => call.argv[1] === "cp")).toBe(false)
    expect(calls.some((call) => call.argv.includes("down"))).toBe(false)
    expect(readHostState(path.join(home, "workspaces"), "idle-key")?.boxProject).toBe("opencode-delegate")
  })

  test("a dirty tag keeps profile_changed and does not start a project", async () => {
    await writeOwner()
    const calls: Call[] = []
    const error = await fail(supervisor(deps(fakeDocker(oldBox(), calls), { image: DIRTY })).ensure())
    expect(error.code).toBe("profile_changed")
    expect(error.action).toContain("oc_server_restart")
    expect(error.message).not.toContain("waiting")
    expect(calls.some((call) => call.argv.includes("up"))).toBe(false)
  })

  test("a third project waits and nothing is stopped", async () => {
    await writeOwner()
    await writeFile(path.join(home, "generations.json"), JSON.stringify({ projects: ["opencode-delegate-bbbbbbbbbbbb"] }) + "\n")
    const calls: Call[] = []
    const other: Box = { running: true, labels: {}, env: [] }
    const error = await fail(supervisor(deps(fakeDocker(oldBox(), calls, { projects: { "opencode-delegate-bbbbbbbbbbbb": other } }), { image: IMAGE })).ensure())
    expect(error.code).toBe("profile_changed")
    expect(error.message).toContain("waiting")
    expect(error.action).toContain("Do not call oc_server_restart")
    expect(calls.some((call) => call.argv.includes("up"))).toBe(false)
    expect(calls.some((call) => call.argv.includes("down"))).toBe(false)
  })

  test("a generation that is already running is reused", async () => {
    await writeOwner()
    const image = IMAGE
    const planned = await planFor(deps(async () => ({ code: 0, stdout: "", stderr: "" }), { image }))
    const generation: Box = {
      running: true,
      labels: { [L.hash]: planned.built.hash, [L.port]: "4800", [L.image]: image, [L.front]: planned.front.hash },
      env: ["OPENCODE_SERVER_PASSWORD=kept", `OPENCODE_MCP_ALLOW=${mcpAllowPolicy(planned.config)}`],
    }
    const calls: Call[] = []
    const target = await supervisor(deps(fakeDocker(oldBox(), calls, { projects: { [NEXT]: generation } }), { image })).ensure()
    expect(target).toEqual({ baseUrl: "http://127.0.0.1:4800", password: "kept" })
    expect(calls.some((call) => call.argv.includes("up"))).toBe(false)
    expect(downOf(calls, "opencode-delegate")).toHaveLength(1)
    expect(downOf(calls, NEXT)).toHaveLength(0)
    expect(JSON.parse(await readFile(path.join(home, "generations.json"), "utf8")).projects).toEqual([NEXT])
  })

  test("a stopped sibling still refuses, and the first start stays on the configured project", async () => {
    await writeOwner()
    const image = IMAGE
    const planned = await planFor(deps(async () => ({ code: 0, stdout: "", stderr: "" }), { image }))
    const box: Box = {
      running: true,
      labels: { [L.hash]: planned.built.hash, [L.port]: "4711", [L.image]: image, [L.front]: planned.front.hash },
      env: ["OPENCODE_SERVER_PASSWORD=x", `OPENCODE_MCP_ALLOW=${mcpAllowPolicy(planned.config)}`],
    }
    const stopped = {
      "opencode-delegate-inbox": {
        code: 0,
        stdout: JSON.stringify({ state: { Running: false }, labels: { [L.image]: image, [L.front]: planned.front.hash }, env: [], image: "x" }),
        stderr: "",
      },
    }
    const refused: Call[] = []
    const error = await fail(supervisor(deps(fakeDocker(box, refused, { containers: stopped }), { image })).ensure())
    expect(error.code).toBe("sandbox_unavailable")
    expect(refused.some((call) => call.argv.includes("up"))).toBe(false)
    const fresh: Call[] = []
    await supervisor(deps(fakeDocker({ running: false, labels: {}, env: [] }, fresh), { image })).ensure()
    expect(fresh.find((call) => call.argv.includes("up"))!.env!.OCD_CONTAINER).toBe("opencode-delegate")
  })

  test("a stopped base joins the generation that is already running for this image", async () => {
    await writeOwner()
    const planned = await planFor(deps(async () => ({ code: 0, stdout: "", stderr: "" }), { image: IMAGE }))
    const generation: Box = {
      running: true,
      labels: { [L.hash]: planned.built.hash, [L.port]: "4800", [L.image]: IMAGE, [L.front]: planned.front.hash },
      env: ["OPENCODE_SERVER_PASSWORD=kept", `OPENCODE_MCP_ALLOW=${mcpAllowPolicy(planned.config)}`],
    }
    const calls: Call[] = []
    const used = deps(fakeDocker({ running: false, labels: {}, env: [] }, calls, { projects: { [NEXT]: generation } }), { image: IMAGE })
    const target = await supervisor(used).ensure()
    expect(target).toEqual({ baseUrl: "http://127.0.0.1:4800", password: "kept" })
    expect(used.config.project).toBe(NEXT)
    expect(calls.some((call) => call.argv.includes("up"))).toBe(false)
    expect(downOf(calls, NEXT)).toHaveLength(0)
  })

  test("a stopped base waits when two other sandboxes are already running", async () => {
    await writeOwner()
    await writeFile(
      path.join(home, "generations.json"),
      JSON.stringify({ projects: ["opencode-delegate-bbbbbbbbbbbb", "opencode-delegate-cccccccccccc"] }) + "\n",
    )
    const calls: Call[] = []
    const other: Box = { running: true, labels: {}, env: [] }
    const error = await fail(
      supervisor(
        deps(
          fakeDocker({ running: false, labels: {}, env: [] }, calls, {
            projects: { "opencode-delegate-bbbbbbbbbbbb": other, "opencode-delegate-cccccccccccc": { ...other } },
          }),
          { image: IMAGE },
        ),
      ).ensure(),
    )
    expect(error.code).toBe("profile_changed")
    expect(error.message).toContain("waiting")
    expect(calls.some((call) => call.argv.includes("up"))).toBe(false)
    expect(calls.some((call) => call.argv.includes("down"))).toBe(false)
  })

  test("a silent old box stays up the first time, then stops after the wait", async () => {
    await writeOwner()
    const quiet = "opencode-delegate-bbbbbbbbbbbb"
    const loud = "opencode-delegate-cccccccccccc"
    await writeFile(path.join(home, "generations.json"), JSON.stringify({ projects: [quiet, loud] }) + "\n")
    await mkdir(path.join(home, "silent"), { recursive: true })
    await writeFile(path.join(home, "silent", loud), "0\n")
    const pin = (sessionKey: string, sessionID: string, boxProject: string) =>
      writeHostState(path.join(home, "workspaces"), {
        sessionKey,
        hostRepo: "C:\\GitHub\\demo",
        base: BASE,
        createdAt: new Date(0).toISOString(),
        sessionID,
        supervisor: "supervisor:test",
        profile: "standard",
        boxProject,
      })
    pin("quiet-key", CALLER, quiet)
    pin("loud-key", "ses_loudsession1", loud)
    const calls: Call[] = []
    const quietBox: Box = { running: true, labels: {}, env: [] }
    const loudBox: Box = { running: true, labels: { [L.port]: "4801" }, env: ["OPENCODE_SERVER_PASSWORD=kept"] }
    let now = 1_000
    const fetchOk = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/session/status")) return Response.json({ ses_loudsession1: { type: "busy" } })
      return new Response("", { status: 200 })
    }) as typeof fetch
    const sup = supervisor(
      deps(fakeDocker({ running: false, labels: {}, env: [] }, calls, { projects: { [quiet]: quietBox, [loud]: loudBox } }), {
        image: IMAGE,
        now: () => now,
        fetch: fetchOk,
      }),
    )
    const first = await fail(sup.ensure())
    expect(first.code).toBe("profile_changed")
    expect(downOf(calls, quiet)).toHaveLength(0)
    expect(downOf(calls, loud)).toHaveLength(0)
    expect(existsSync(path.join(home, "silent", quiet))).toBe(true)
    expect(existsSync(path.join(home, "silent", loud))).toBe(false)
    // Checks every 30 s revalidate: the silence must last the whole wait, with no long gap.
    for (let waited = 0; waited < SILENT_BOX_WAIT_MS; waited += 30_000) {
      expect(downOf(calls, quiet)).toHaveLength(0)
      now += 30_000
      await sup.ensure().catch(() => undefined)
    }
    const down = downOf(calls, quiet)
    expect(down).toHaveLength(1)
    expect(down[0]?.argv.includes("-v")).toBe(false)
    expect(downOf(calls, loud)).toHaveLength(0)
    expect(readHostState(path.join(home, "workspaces"), "quiet-key")?.sessionID).toBe(CALLER)
    expect(readHostState(path.join(home, "workspaces"), "loud-key")?.boxProject).toBe(loud)
  })

  test("a live lease keeps a silent box up", async () => {
    await writeOwner()
    const quiet = "opencode-delegate-bbbbbbbbbbbb"
    await writeFile(path.join(home, "generations.json"), JSON.stringify({ projects: [quiet, "opencode-delegate-cccccccccccc"] }) + "\n")
    writeHostState(path.join(home, "workspaces"), {
      sessionKey: "quiet-key",
      hostRepo: "C:\\GitHub\\demo",
      base: BASE,
      createdAt: new Date(0).toISOString(),
      sessionID: CALLER,
      supervisor: "supervisor:test",
      profile: "standard",
      boxProject: quiet,
    })
    const lease = path.join(home, "generations", quiet, "leases")
    await mkdir(lease, { recursive: true })
    await writeFile(path.join(lease, "bridge-old"), JSON.stringify({ pid: process.pid, startedAt: 1 }) + "\n")
    await mkdir(path.join(home, "silent"), { recursive: true })
    await writeFile(path.join(home, "silent", quiet), "0\n")
    const calls: Call[] = []
    const other: Box = { running: true, labels: {}, env: [] }
    const error = await fail(
      supervisor(
        deps(
          fakeDocker({ running: false, labels: {}, env: [] }, calls, {
            projects: { [quiet]: other, "opencode-delegate-cccccccccccc": { ...other } },
          }),
          { image: IMAGE, now: () => SILENT_BOX_WAIT_MS + 5_000 },
        ),
      ).ensure(),
    )
    expect(error.code).toBe("profile_changed")
    expect(downOf(calls, quiet)).toHaveLength(0)
  })

  test("a box that hangs counts as silent within the 3 s probe cap (architect on #234)", async () => {
    await writeOwner()
    const quiet = "opencode-delegate-dddddddddddd"
    await writeFile(path.join(home, "generations.json"), JSON.stringify({ projects: [quiet, "opencode-delegate-cccccccccccc"] }) + "\n")
    writeHostState(path.join(home, "workspaces"), {
      sessionKey: "hang-key",
      hostRepo: "C:\\GitHub\\demo",
      base: BASE,
      createdAt: new Date(0).toISOString(),
      sessionID: CALLER,
      supervisor: "supervisor:test",
      profile: "standard",
      boxProject: quiet,
    })
    const calls: Call[] = []
    // Accepts the connection and never answers, like Docker Desktop holding a published port open.
    const hung: Box = { running: true, labels: { [L.port]: "4802" }, env: ["OPENCODE_SERVER_PASSWORD=kept"] }
    const hangs = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes(":4802/"))
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))),
        )
      return new Response("", { status: 200 })
    }) as typeof fetch
    const started = Date.now()
    const error = await fail(
      supervisor(
        deps(fakeDocker({ running: false, labels: {}, env: [] }, calls, { projects: { [quiet]: hung, "opencode-delegate-cccccccccccc": { running: true, labels: {}, env: [] } } }), {
          image: IMAGE,
          fetch: hangs,
          now: () => 1_000,
        }),
      ).ensure(),
    )
    expect(error.code).toBe("profile_changed")
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(existsSync(path.join(home, "silent", quiet))).toBe(true)
    expect(downOf(calls, quiet)).toHaveLength(0)
  }, 20_000)

  test("a gap longer than SILENT_GAP_MS between checks starts the wait again (#234 QA)", async () => {
    await writeOwner()
    const quiet = "opencode-delegate-ffffffffffff"
    await writeFile(path.join(home, "generations.json"), JSON.stringify({ projects: [quiet, "opencode-delegate-cccccccccccc"] }) + "\n")
    writeHostState(path.join(home, "workspaces"), {
      sessionKey: "gap-key",
      hostRepo: "C:\\GitHub\\demo",
      base: BASE,
      createdAt: new Date(0).toISOString(),
      sessionID: CALLER,
      supervisor: "supervisor:test",
      profile: "standard",
      boxProject: quiet,
    })
    // Silent since 0, last seen silent at 0: then nothing checked for the whole wait (PC asleep).
    await mkdir(path.join(home, "silent"), { recursive: true })
    await writeFile(path.join(home, "silent", quiet), "0 0\n")
    const calls: Call[] = []
    const error = await fail(
      supervisor(
        deps(fakeDocker({ running: false, labels: {}, env: [] }, calls, { projects: { [quiet]: { running: true, labels: {}, env: [] }, "opencode-delegate-cccccccccccc": { running: true, labels: {}, env: [] } } }), {
          image: IMAGE,
          now: () => SILENT_BOX_WAIT_MS + SILENT_GAP_MS + 5_000,
        }),
      ).ensure(),
    )
    expect(error.code).toBe("profile_changed")
    expect(downOf(calls, quiet)).toHaveLength(0)
    const stamp = (await readFile(path.join(home, "silent", quiet), "utf8")).trim()
    expect(stamp).toBe(`${SILENT_BOX_WAIT_MS + SILENT_GAP_MS + 5_000} ${SILENT_BOX_WAIT_MS + SILENT_GAP_MS + 5_000}`)
  })

  test("a box that is still starting resets its silent wait (architect on #234)", async () => {
    await writeOwner()
    const quiet = "opencode-delegate-eeeeeeeeeeee"
    await writeFile(path.join(home, "generations.json"), JSON.stringify({ projects: [quiet, "opencode-delegate-cccccccccccc"] }) + "\n")
    writeHostState(path.join(home, "workspaces"), {
      sessionKey: "fresh-key",
      hostRepo: "C:\\GitHub\\demo",
      base: BASE,
      createdAt: new Date(0).toISOString(),
      sessionID: CALLER,
      supervisor: "supervisor:test",
      profile: "standard",
      boxProject: quiet,
    })
    // An old stamp from the box this one replaced.
    await mkdir(path.join(home, "silent"), { recursive: true })
    await writeFile(path.join(home, "silent", quiet), "0\n")
    const calls: Call[] = []
    const fresh: Box = { running: true, labels: {}, env: [], health: "starting" }
    const error = await fail(
      supervisor(
        deps(fakeDocker({ running: false, labels: {}, env: [] }, calls, { projects: { [quiet]: fresh, "opencode-delegate-cccccccccccc": { running: true, labels: {}, env: [] } } }), {
          image: IMAGE,
          now: () => SILENT_BOX_WAIT_MS + 5_000,
        }),
      ).ensure(),
    )
    expect(error.code).toBe("profile_changed")
    expect(downOf(calls, quiet)).toHaveLength(0)
    expect(existsSync(path.join(home, "silent", quiet))).toBe(false)
  })

  test("a generation that does not match is refused before this bridge rebinds", async () => {
    await writeOwner()
    const calls: Call[] = []
    const generation: Box = {
      running: true,
      labels: { [L.hash]: "old", [L.port]: "4800", [L.image]: "img:0.9.0-1111111", [L.front]: "old" },
      env: ["OPENCODE_SERVER_PASSWORD=x", "OPENCODE_MCP_ALLOW={}"],
    }
    const used = deps(fakeDocker({ running: false, labels: {}, env: [] }, calls, { projects: { [NEXT]: generation } }), { image: IMAGE })
    let bound: string | undefined
    used.onBound = (project) => {
      bound = project
    }
    const error = await fail(supervisor(used).ensure())
    expect(error.code).toBe("profile_changed")
    expect(used.config.project).toBe("opencode-delegate")
    expect(bound).toBeUndefined()
    expect(calls.some((call) => call.argv.includes("up"))).toBe(false)
  })

  test("a failed open removes the copied clone and keeps the caller record", async () => {
    await writeOwner()
    record()
    const calls: Call[] = []
    const failedOpen = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/session/status")) return Response.json({})
      if (url.includes("/permission") || url.includes("/question")) return Response.json([])
      if ((init?.method ?? "GET") === "POST" && url.includes("/session")) return new Response("no", { status: 500 })
      return new Response("", { status: 200 })
    }) as typeof fetch
    await supervisor(deps(fakeDocker(oldBox(), calls), { image: IMAGE, fetch: failedOpen })).ensure()
    expect(calls.some((call) => call.argv[1] === "cp")).toBe(true)
    expect(calls.some((call) => call.argv[1] === "exec" && call.argv.includes("rm") && call.argv.includes(`/sessions/idle-key`))).toBe(true)
    const state = readHostState(path.join(home, "workspaces"), "idle-key")
    expect(state?.sessionID).toBe(CALLER)
    expect(state?.boxSessionID).toBeUndefined()
    expect(state?.boxProject).toBe("opencode-delegate")
    expect(downOf(calls, "opencode-delegate")).toHaveLength(0)
  })

  test("a failed session delete leaves the copied clone in place", async () => {
    await writeOwner()
    record()
    await mkdir(path.join(home, "workspaces", `idle-key.json.${process.pid}.tmp`), { recursive: true })
    const calls: Call[] = []
    const failedDelete = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      if (url.includes("/session/status")) return Response.json({})
      if (url.includes("/permission") || url.includes("/question")) return Response.json([])
      if (method === "POST" && url.includes("/session")) return Response.json({ id: MOVED })
      if (method === "DELETE") return new Response("no", { status: 500 })
      return new Response("", { status: 200 })
    }) as typeof fetch
    await supervisor(deps(fakeDocker(oldBox(), calls), { image: IMAGE, fetch: failedDelete })).ensure()
    expect(calls.some((call) => call.argv[1] === "cp")).toBe(true)
    expect(calls.some((call) => call.argv[1] === "exec" && call.argv.includes("rm"))).toBe(false)
    const state = readHostState(path.join(home, "workspaces"), "idle-key")
    expect(state?.sessionID).toBe(CALLER)
    expect(state?.boxSessionID).toBeUndefined()
    expect(state?.boxProject).toBe("opencode-delegate")
  })

  test("a failed clone removal is reported and the caller record stays", async () => {
    await writeOwner()
    record()
    const calls: Call[] = []
    const log = recorder()
    const failedOpen = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/session/status")) return Response.json({})
      if (url.includes("/permission") || url.includes("/question")) return Response.json([])
      if ((init?.method ?? "GET") === "POST" && url.includes("/session")) return new Response("no", { status: 500 })
      return new Response("", { status: 200 })
    }) as typeof fetch
    await supervisor(
      deps(
        fakeDocker(oldBox(), calls, {
          exec: (argv) =>
            argv.includes("rm")
              ? { code: 1, stdout: "", stderr: "busy" }
              : { code: 0, stdout: JSON.stringify({ names: [], removed: [] }), stderr: "" },
        }),
        {
          image: IMAGE,
          fetch: failedOpen,
          log,
        },
      ),
    ).ensure()
    expect(calls.some((call) => call.argv[1] === "exec" && call.argv.includes("rm") && call.argv.includes("/sessions/idle-key"))).toBe(true)
    expect(log.lines.some((line) => line.level === "warn" && line.msg === "copied clone was not removed")).toBe(true)
    const state = readHostState(path.join(home, "workspaces"), "idle-key")
    expect(state?.sessionID).toBe(CALLER)
    expect(state?.boxSessionID).toBeUndefined()
    expect(state?.boxProject).toBe("opencode-delegate")
  })

  test("a session older than the newest 200 keeps its sandbox up", async () => {
    await writeOwner()
    const dir = path.join(home, "workspaces")
    for (let i = 0; i < 200; i++) {
      writeHostState(dir, {
        sessionKey: `kept-${String(i).padStart(4, "0")}`,
        hostRepo: "C:\\GitHub\\demo",
        base: BASE,
        createdAt: new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString(),
        sessionID: `ses_${String(i).padStart(8, "0")}`,
        supervisor: "supervisor:test",
        profile: "standard",
        boxProject: NEXT,
      })
    }
    writeHostState(dir, {
      sessionKey: "old-kept-key",
      hostRepo: "C:\\GitHub\\demo",
      base: BASE,
      createdAt: "2000-01-01T00:00:00.000Z",
      sessionID: CALLER,
      supervisor: "supervisor:test",
      profile: "standard",
      boxProject: "opencode-delegate",
    })
    const calls: Call[] = []
    await supervisor(deps(fakeDocker(oldBox(), calls), { image: IMAGE, fetch: fetchFor({ [CALLER]: { type: "busy" } }) })).ensure()
    expect(downOf(calls, "opencode-delegate")).toHaveLength(0)
    expect(readHostState(dir, "old-kept-key")?.boxProject).toBe("opencode-delegate")
    expect(readHostState(dir, "old-kept-key")?.sessionID).toBe(CALLER)
  })
})
