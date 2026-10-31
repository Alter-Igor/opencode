import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync } from "fs"
import path from "path"
import { ShellTimeoutCap } from "../plugins/shell-timeout-cap"

const ENV = "SBXW_SHELL_MAX_TIMEOUT_MS"
const saved = process.env[ENV]
afterEach(() => {
  if (saved === undefined) delete process.env[ENV]
  else process.env[ENV] = saved
})

const load = async (value: string | undefined) => {
  if (value === undefined) delete process.env[ENV]
  else process.env[ENV] = value
  return ShellTimeoutCap()
}

const run = async (hooks: Awaited<ReturnType<typeof ShellTimeoutCap>>, tool: string, args: { timeout?: unknown; command?: string }) => {
  await hooks["tool.execute.before"]?.({ tool, callID: "call-1" }, { args })
  return args
}

describe("shell timeout cap (#249)", () => {
  test("a timeout above the cap is lowered to the cap, in the same args object", async () => {
    const hooks = await load("120000")
    const args = { command: "sleep 9999", timeout: 1_536_000 }
    expect(await run(hooks, "bash", args)).toBe(args)
    expect(args).toEqual({ command: "sleep 9999", timeout: 120000 })
  })

  test("a smaller or equal timeout is kept", async () => {
    const hooks = await load("120000")
    expect((await run(hooks, "bash", { timeout: 5000 })).timeout).toBe(5000)
    expect((await run(hooks, "bash", { timeout: 120000 })).timeout).toBe(120000)
  })

  test("an omitted timeout stays omitted, so the tool default applies", async () => {
    const hooks = await load("120000")
    expect("timeout" in (await run(hooks, "bash", { command: "ls" }))).toBe(false)
  })

  test("a negative or non-number timeout is left for the tool to reject", async () => {
    const hooks = await load("120000")
    expect((await run(hooks, "bash", { timeout: -1 })).timeout).toBe(-1)
    expect((await run(hooks, "bash", { timeout: "999999" })).timeout).toBe("999999")
  })

  test("other tools are untouched", async () => {
    const hooks = await load("120000")
    expect((await run(hooks, "webfetch", { timeout: 999_999 })).timeout).toBe(999_999)
  })

  test.each([undefined, "", " ", "abc", "0", "-5", "1.5", "NaN", "Infinity"])("cap %p means off: no hooks", async (value) => {
    const hooks = await load(value)
    expect(hooks).toEqual({})
  })

  test("the description says the limit, only for bash and only when on", async () => {
    const on = await load("300000")
    const bash = { description: "Runs a command." }
    await on["tool.definition"]?.({ toolID: "bash" }, bash)
    expect(bash.description).toBe("Runs a command.\n\nIn this sandbox a timeout above 300000 ms is lowered to 300000 ms.")
    const other = { description: "Fetches a page." }
    await on["tool.definition"]?.({ toolID: "webfetch" }, other)
    expect(other.description).toBe("Fetches a page.")
    const off = await load(undefined)
    expect(off["tool.definition"]).toBeUndefined()
  })

  test("the plugin file exports only the factory (OpenCode loads every function export)", async () => {
    expect(Object.keys(await import("../plugins/shell-timeout-cap"))).toEqual(["ShellTimeoutCap"])
  })
})

describe("plugin install (#249)", () => {
  test("every file in plugins/ is installed by supervisor/main.ts", async () => {
    const main = await Bun.file(path.join(import.meta.dir, "../supervisor/main.ts")).text()
    const plugins = readdirSync(path.join(import.meta.dir, "../plugins"))
    expect(plugins.length).toBeGreaterThan(1)
    for (const file of plugins) {
      expect(main).toContain(`path.join(configDir, "plugins", "${file}"), Bun.file("/opt/sbxw/plugins/${file}")`)
    }
  })
})
