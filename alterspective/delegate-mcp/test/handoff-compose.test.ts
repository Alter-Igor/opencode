// G-7 / R3-08 — static check on docker/compose.yaml: no service, and the box above all, can write a
// host folder. Host binds are read-only; the box's /handoff/out is a box-only named volume.
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

type Compose = { services: Record<string, { volumes?: string[] }>; volumes: Record<string, unknown> }
const compose = Bun.YAML.parse(await readFile(path.join(import.meta.dir, "..", "docker", "compose.yaml"), "utf8")) as Compose

/** Short syntax `source:target[:mode]`; a source that is a path or a variable is a host folder. */
const parse = (spec: string) => {
  // `${VAR:?message}` holds a colon of its own: fold each variable to `$VAR` before splitting.
  const [source = "", target = "", mode = ""] = spec.replace(/\$\{([A-Z_]+)[^}]*\}/g, "$$$1").split(":")
  return { source, target, mode, host: /^[$./~]|^[A-Za-z]:[\\/]/.test(source) }
}

describe("G-7: no writable host bind mount", () => {
  test("the box's only host folders are mounted read-only", () => {
    const binds = (compose.services.box?.volumes ?? []).map(parse).filter((m) => m.host)
    expect(binds.map((m) => m.target).sort()).toEqual(["/handoff/in", "/profile"])
    for (const m of binds) expect({ target: m.target, mode: m.mode }).toEqual({ target: m.target, mode: "ro" })
  })

  test("the box's /handoff/out is a declared named volume, not a host folder", () => {
    const out = (compose.services.box?.volumes ?? []).map(parse).find((m) => m.target === "/handoff/out")
    expect(out).toMatchObject({ source: "handoff-out", host: false })
    expect("handoff-out" in compose.volumes).toBe(true)
  })

  test("no service anywhere has a writable host bind", () => {
    const writable = Object.entries(compose.services).flatMap(([name, s]) => (s.volumes ?? []).map(parse).filter((m) => m.host && !m.mode.split(",").includes("ro")).map((m) => `${name}:${m.target}`))
    expect(writable).toEqual([])
  })
})
