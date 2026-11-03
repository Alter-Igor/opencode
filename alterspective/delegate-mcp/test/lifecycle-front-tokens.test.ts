import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { defaultConfig, mcpAllowPolicy } from "../src/shared/config.ts"
import { BOX_MEM_LIMIT_ENV, FORWARDER_SIBLING_SERVICES, composeEnv, forwarderSiblingContainers } from "../src/supervisor/compose-env.ts"
import { parseInspect } from "../src/supervisor/docker.ts"
import { frontFilesFor } from "../src/supervisor/plan.ts"
import { buildProfile } from "../src/supervisor/profile.ts"
import { KS_AUTH_VAR, authConfPath, ksAuthConfPath, writeAuthConf, writeKsAuthConf } from "../src/synapse/auth-conf.ts"
import { jwt } from "./synapse-fixture.ts"
import { IMAGE, L, deps, fail, fakeDocker, home, owner, recorder, supervisor, useSupervisorFixture, writeOwner, type Box, type Call } from "./supervisor-lifecycle-fixture.ts"

useSupervisorFixture()

const GEN_IMAGE = "img:1.0.0-abcdef012345"
const NEXT = "opencode-delegate-abcdef012345"
const ACCESS = jwt({ sub: "oid-1", email: "owner@example.test", act: { sub: "service:opencode" } })

async function reusable(image = IMAGE): Promise<Box> {
  await writeOwner()
  const d = deps(async () => ({ code: 0, stdout: "", stderr: "" }), { image })
  const hash = buildProfile({ ownerConfigs: [owner], config: d.config, permission: d.permission, keyEnv: d.keyEnv }).hash
  const front = frontFilesFor(d.config).hash
  return {
    running: true,
    labels: { [L.hash]: hash, [L.port]: "4711", [L.image]: image, [L.front]: front },
    env: ["OPENCODE_SERVER_PASSWORD=x", `OPENCODE_MCP_ALLOW=${mcpAllowPolicy(defaultConfig())}`],
  }
}

describe("#187 and #206: re-binding active running box in statusOf and ensure", () => {
  test("statusOf and ensure re-bind to the running base box when the bound generation stops, firing onBound", async () => {
    const genBox = await reusable(GEN_IMAGE)
    const baseBox: Box = { ...genBox, running: false }
    const projects: Record<string, Box> = { [NEXT]: { ...genBox, running: true } }
    const bound: string[] = []
    const d = deps(fakeDocker(baseBox, [], { projects }), {
      image: GEN_IMAGE,
      onBound: (project) => void bound.push(project),
    })
    const sup = supervisor(d)

    // 1. Base is stopped while generation NEXT is running -> statusOf binds to NEXT.
    const st1 = await sup.status()
    expect(st1.state).toBe("running")
    expect(d.config.project).toBe(NEXT)
    expect(bound).toEqual([NEXT])

    // 2. Generation NEXT stops while base opencode-delegate starts -> statusOf re-binds to base.
    projects[NEXT]!.running = false
    baseBox.running = true
    const st2 = await sup.status()
    expect(st2.state).toBe("running")
    expect(d.config.project).toBe("opencode-delegate")
    expect(bound).toEqual([NEXT, "opencode-delegate"])

    // 3. Acquire a lease on NEXT via ensure(), then stop NEXT and start base -> status() releases NEXT's lease and re-binds to base.
    baseBox.running = false
    projects[NEXT]!.running = true
    await sup.ensure()
    expect(d.config.project).toBe(NEXT)
    const nextLease = path.join(home, "generations", NEXT, "leases", "bridge-a")
    expect(existsSync(nextLease)).toBe(true)

    projects[NEXT]!.running = false
    baseBox.running = true
    await sup.status()
    expect(d.config.project).toBe("opencode-delegate")
    expect(existsSync(nextLease)).toBe(false)

    // 4. Place back onto NEXT via statusOf, then stop NEXT and start base -> ensure() re-binds to base.
    baseBox.running = false
    projects[NEXT]!.running = true
    await sup.status()
    expect(d.config.project).toBe(NEXT)

    projects[NEXT]!.running = false
    baseBox.running = true
    await sup.ensure()
    expect(d.config.project).toBe("opencode-delegate")
    expect(bound).toEqual([NEXT, "opencode-delegate", NEXT, "opencode-delegate", NEXT, "opencode-delegate"])
  })
})

describe("#180 item 3: prepareFiles seeds generation front folder from base front under synapseLock", () => {
  test("a new generation box starts with synapse-auth.conf and chosen ks-auth-<id>.conf seeded from <home>/front", async () => {
    await writeOwner()
    const baseFront = path.join(home, "front")
    mkdirSync(baseFront, { recursive: true })
    await writeAuthConf(baseFront, ACCESS)
    await writeKsAuthConf(baseFront, "rag-read", ACCESS)

    const oldRunning: Box = {
      running: true,
      labels: { [L.hash]: "old", [L.port]: "4711", [L.image]: "img:0.9.0-1111111", [L.front]: "old" },
      env: ["OPENCODE_SERVER_PASSWORD=x", "OPENCODE_MCP_ALLOW={}"],
    }
    const before = process.env.OCD_KEYSTONE_HOST_AUTH
    process.env.OCD_KEYSTONE_HOST_AUTH = "1"
    try {
      const calls: Call[] = []
      const sup = supervisor(deps(fakeDocker(oldRunning, calls), { image: GEN_IMAGE }))
      await sup.ensure()
      const genFront = path.join(home, "generations", NEXT, "front")
      expect(readFileSync(authConfPath(genFront), "utf8")).toContain(`"Bearer ${ACCESS}"`)
      expect(readFileSync(ksAuthConfPath(genFront, "rag-read"), "utf8")).toContain(`"Bearer ${ACCESS}"`)
    } finally {
      if (before === undefined) delete process.env.OCD_KEYSTONE_HOST_AUTH
      if (before !== undefined) process.env.OCD_KEYSTONE_HOST_AUTH = before
    }
  })
})

describe("#240: forwarder sibling services check in statusOf and checkSiblings", () => {
  test("FORWARDER_SIBLING_SERVICES exports gate-box, gate-admin, and gate-mcp-admin", () => {
    expect(FORWARDER_SIBLING_SERVICES).toEqual(["gate-box", "gate-admin", "gate-mcp-admin"])
    expect(forwarderSiblingContainers({ project: "opencode-delegate" })).toEqual([
      { service: "gate-box", container: "opencode-delegate-gate-box" },
      { service: "gate-admin", container: "opencode-delegate-gate-admin" },
      { service: "gate-mcp-admin", container: "opencode-delegate-gate-mcp-admin" },
    ])
  })

  test("statusOf and ensure refuse when a forwarder container (gate-box, gate-admin, gate-mcp-admin) is stopped", async () => {
    const box = await reusable()
    for (const service of FORWARDER_SIBLING_SERVICES) {
      const stopped = {
        [`opencode-delegate-${service}`]: {
          code: 0,
          stdout: JSON.stringify({ state: { Running: false, ExitCode: 1 }, labels: {}, env: [], image: "alpine/socat:1.8.0.3" }),
          stderr: "",
        },
      }
      const sup = supervisor(deps(fakeDocker(box, [], { containers: stopped })))
      const status = await sup.status()
      expect(status).toMatchObject({
        state: "unavailable",
        reason: `The running sandbox's ${service} service is stopped.`,
      })
      const error = await fail(sup.ensure())
      expect(error.code).toBe("sandbox_unavailable")
      expect(error.message).toContain(`${service} service is stopped`)
    }
  })
})

describe("#160: container exit state logging and configurable OCD_BOX_MEM_LIMIT", () => {
  test("parseInspect captures exitCode, oomKilled, finishedAt, and error from .State", () => {
    const info = parseInspect(
      JSON.stringify({
        state: {
          Running: false,
          ExitCode: 137,
          OOMKilled: true,
          FinishedAt: "2026-10-11T03:30:00Z",
          Error: "OOM killed",
        },
        labels: {},
        env: [],
        image: IMAGE,
      }),
      [],
    )
    expect(info).toMatchObject({
      exists: true,
      running: false,
      exitCode: 137,
      oomKilled: true,
      finishedAt: "2026-10-11T03:30:00Z",
      error: "OOM killed",
    })
  })

  test("ensure logs 'replacing stopped sandbox' with exitCode, oomKilled, finishedAt, and error before starting", async () => {
    await writeOwner()
    const log = recorder()
    const stoppedBox = {
      "opencode-delegate": {
        code: 0,
        stdout: JSON.stringify({
          state: {
            Running: false,
            ExitCode: 137,
            OOMKilled: true,
            FinishedAt: "2026-10-11T03:30:00Z",
            Error: "out of memory",
          },
          labels: {},
          env: [],
          image: IMAGE,
        }),
        stderr: "",
      },
    }
    const calls: Call[] = []
    const baseExec = fakeDocker({ running: false, labels: {}, env: [] }, calls, { containers: stoppedBox })
    let upCalled = false
    const exec: typeof baseExec = async (argv, opts) => {
      if (argv.includes("up")) upCalled = true
      if (!upCalled && argv.includes("inspect") && argv.at(-1) === "opencode-delegate") {
        return stoppedBox["opencode-delegate"]
      }
      return baseExec(argv, opts)
    }
    await supervisor(deps(exec, { log })).ensure()
    const warnLine = log.lines.find((line) => line.level === "warn" && line.msg === "replacing stopped sandbox")
    expect(warnLine).toBeDefined()
    expect(warnLine?.fields).toMatchObject({
      container: "opencode-delegate",
      exitCode: 137,
      oomKilled: true,
      finishedAt: "2026-10-11T03:30:00Z",
      error: "out of memory",
    })
  })

  test("compose.yaml uses ${OCD_BOX_MEM_LIMIT:-8g} and composeEnv forwards OCD_BOX_MEM_LIMIT when set", async () => {
    const composePath = path.resolve(import.meta.dir, "..", "docker", "compose.yaml")
    const yaml = readFileSync(composePath, "utf8")
    expect(yaml).toContain("mem_limit: ${OCD_BOX_MEM_LIMIT:-8g}")
    expect(yaml).toContain("memswap_limit: ${OCD_BOX_MEM_LIMIT:-8g}")

    const d = deps(fakeDocker({ running: false, labels: {}, env: [] }, []), {
      hostEnv: { PATH: "p", SYNAPSE_API_KEY: "k-value", [BOX_MEM_LIMIT_ENV]: "12g" },
    })
    const built = buildProfile({ ownerConfigs: [owner], config: d.config, permission: d.permission, keyEnv: d.keyEnv })
    const front = { servers: "x", hash: "f".repeat(64) }
    const env = composeEnv(d, { built, port: 1, password: "pw", front })
    expect(env[BOX_MEM_LIMIT_ENV]).toBe("12g")
  })
})
