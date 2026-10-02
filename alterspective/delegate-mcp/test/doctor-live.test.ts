// R5-05 + R5-01: oc_doctor checks what is RUNNING, not labels and compose text: the servers file
// nginx loaded in `front` (attested by a worker), the live mount modes from `docker inspect`, and the
// MCP sign-ins stored in the box (names only). Each failed check fails closed and says why.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { frontServersFor } from "../src/guard/egress.ts"
import { defaultConfig } from "../src/shared/config.ts"
import { checkMounts, frontLiveFrom } from "../src/supervisor/front-live.ts"
import type { LiveChecks } from "../src/supervisor/live.ts"
import { doctorTool } from "../src/tools/doctor.ts"
import { data, fakeContext, invoke, text } from "./tools-core-fixture.ts"

const SERVERS = frontServersFor(defaultConfig({}))

const FRONT_OK = [{ Destination: "/etc/nginx/front-gen", RW: false }, { Destination: "/ca/private", RW: true }, { Destination: "/ca/public", RW: true }]
const BOX_OK = [
  { Destination: "/data", RW: true, Type: "volume", Name: "p_data", Driver: "local" },
  { Destination: "/sessions", RW: true, Type: "volume", Name: "p_sessions", Driver: "local" },
  { Destination: "/handoff/in", RW: false, Type: "bind" },
  { Destination: "/handoff/out", RW: true, Type: "volume", Name: "p_handoff-out", Driver: "local" },
  { Destination: "/profile", RW: false, Type: "bind" },
  { Destination: "/etc/ocd-front-ca", RW: false, Type: "volume", Name: "p_front-ca-public", Driver: "local" },
]
/** `docker volume inspect` Options of plain local volumes (Docker prints null). */
const VOLS_OK = { p_data: null, p_sessions: null, "p_handoff-out": null }

describe("front's loaded config (R5-05)", () => {
  test("same file: loaded config matches; another set's file: mismatch with a reason", () => {
    expect(frontLiveFrom({ loaded: SERVERS, expected: SERVERS, frontMounts: FRONT_OK, boxMounts: BOX_OK, boxVolumes: VOLS_OK })).toEqual({ ok: true, loadedConfigMatches: true, mountReadOnly: true, boxMountsOk: true, problems: [] })
    const other = frontServersFor({ ...defaultConfig({}), keystoneConnections: ["m365"] })
    const live = frontLiveFrom({ loaded: other, expected: SERVERS, frontMounts: FRONT_OK, boxMounts: BOX_OK, boxVolumes: VOLS_OK })
    expect(live).toMatchObject({ ok: false, loadedConfigMatches: false })
    expect(live.problems.join(" ")).toContain("not the one generated")
    expect(frontLiveFrom({ loaded: undefined, expected: SERVERS, frontMounts: FRONT_OK, boxMounts: BOX_OK, boxVolumes: VOLS_OK })).toMatchObject({ ok: false, loadedConfigMatches: false, problems: [expect.stringContaining("running worker")] })
  })

  test("live mounts: front's generated folder must be read-only; the box gets exactly its own mounts", () => {
    expect(checkMounts(FRONT_OK, BOX_OK, VOLS_OK)).toEqual({ mountReadOnly: true, boxMountsOk: true, problems: [] })
    expect(checkMounts([{ Destination: "/etc/nginx/front-gen", RW: true }], BOX_OK, VOLS_OK)).toMatchObject({ mountReadOnly: false, problems: [expect.stringContaining("read-write")] })
    expect(checkMounts([], BOX_OK, VOLS_OK)).toMatchObject({ mountReadOnly: false })
    expect(checkMounts(FRONT_OK, [...BOX_OK, { Destination: "/bridge-home", RW: true }], VOLS_OK)).toMatchObject({ boxMountsOk: false, problems: [expect.stringContaining("/bridge-home")] })
    expect(checkMounts(FRONT_OK, BOX_OK.map((m) => (m.Destination === "/profile" ? { ...m, RW: true } : m)), VOLS_OK)).toMatchObject({ boxMountsOk: false })
    expect(checkMounts(undefined, undefined, {})).toMatchObject({ mountReadOnly: false, boxMountsOk: false })
    // G-7: a writable host folder in the box (the old /handoff/out bind) fails the check.
    const oldBind = checkMounts(FRONT_OK, BOX_OK.map((m) => (m.Destination === "/handoff/out" ? { ...m, Type: "bind" } : m)), VOLS_OK)
    expect(oldBind).toMatchObject({ boxMountsOk: false, problems: [expect.stringContaining("writable bind mount")] })
  })

  test("L4: a writable box volume must be a plain local volume, not a host folder in disguise", () => {
    const out = (patch: Record<string, unknown>) => BOX_OK.map((m) => (m.Destination === "/handoff/out" ? { ...m, ...patch } : m))
    const problems = (box: typeof BOX_OK, vols: Record<string, Record<string, string> | null | undefined>) => checkMounts(FRONT_OK, box, vols).problems
    expect(problems(out({ Driver: "nfs" }), VOLS_OK)).toEqual([expect.stringContaining("driver nfs, not local")])
    expect(problems(BOX_OK, { ...VOLS_OK, "p_handoff-out": { type: "none", o: "bind", device: "C:\\Users\\x" } })).toEqual([expect.stringContaining("backed by a host folder")])
    expect(problems(BOX_OK, { ...VOLS_OK, "p_handoff-out": { o: "rbind" } })).toEqual([expect.stringContaining("backed by a host folder")])
    expect(problems(BOX_OK, { ...VOLS_OK, "p_handoff-out": { o: "rw,bind" } })).toEqual([expect.stringContaining("backed by a host folder")])
    expect(problems(BOX_OK, { ...VOLS_OK, "p_handoff-out": { device: "/dev/sdb1" } })).toEqual([expect.stringContaining("backed by a host folder")])
    expect(problems(BOX_OK, { ...VOLS_OK, "p_handoff-out": { type: "tmpfs", o: "size=100m" } })).toEqual([])
    const { ["p_handoff-out"]: _gone, ...missing } = VOLS_OK
    expect(problems(BOX_OK, missing)).toEqual([expect.stringContaining("could not be inspected")])
  })
})

describe("front refuses to start with a servers file that is not the labelled one (R5-05)", () => {
  const docker = path.join(import.meta.dir, "..", "docker")
  test("compose gives front OCD_FRONT_HASH, and the entrypoint compares it with the file before nginx starts", () => {
    const compose = Bun.YAML.parse(readFileSync(path.join(docker, "compose.yaml"), "utf8")) as { services: { front: { environment: Record<string, string> } } }
    expect(compose.services.front.environment.OCD_FRONT_HASH).toBe("${OCD_FRONT_HASH:?OCD_FRONT_HASH is set by the bridge}")
    const entry = readFileSync(path.join(docker, "front", "entrypoint.sh"), "utf8")
    const check = entry.indexOf('sha256sum /etc/nginx/front-gen/servers.conf')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(entry.indexOf("exec nginx"))
    expect(entry).toContain('[ "$actual" = "$OCD_FRONT_HASH" ]')
  })
})

describe("oc_doctor live checks", () => {
  const CHOSEN = { "ks-rag-read": { status: "connected" }, "ks-github": { status: "connected" }, "ks-seqlogs": { status: "connected" } }
  const liveOk: LiveChecks = {
    ok: true,
    signIns: { ok: true, names: ["ks-rag-read", "ks-github", "ks-seqlogs"], stale: [], unrecognised: 0, removedBefore: [] },
    front: { ok: true, loadedConfigMatches: true, mountReadOnly: true, boxMountsOk: true, problems: [] },
    problems: [],
  }

  test("a stale stored sign-in or a front that loaded another file is NOT verified, and the summary says why", async () => {
    for (const live of [
      { ...liveOk, ok: false, signIns: { ...liveOk.signIns, ok: false, stale: ["ks-test-stale"] }, problems: ["stored sign-ins outside the chosen set: ks-test-stale"] },
      { ...liveOk, ok: false, front: { ...liveOk.front, ok: false, loadedConfigMatches: false, problems: ["x"] }, problems: ["front loaded another servers.conf"] },
    ] satisfies LiveChecks[]) {
      const f = fakeContext({ boxHeld: false })
      f.api.on("GET /mcp", { status: 200, data: CHOSEN })
      f.live.value = live
      const result = await invoke(doctorTool, {}, f.ctx)
      expect(data(result)).toMatchObject({ verified: false, live: { ok: false } })
      expect(text(result)).toContain("NOT verified")
      expect(text(result)).toContain(live.problems[0]!)
    }
  })

  test("review L6: every chosen Keystone entry must be listed by GET /mcp and signed in (or switched off)", async () => {
    const all = fakeContext({ boxHeld: false })
    all.api.on("GET /mcp", { status: 200, data: CHOSEN })
    all.live.value = liveOk
    expect(data(await invoke(doctorTool, {}, all.ctx))).toMatchObject({ verified: true })
    const { ["ks-seqlogs"]: _gone, ...missing } = CHOSEN
    for (const statuses of [missing, { ...CHOSEN, "ks-seqlogs": { status: "disabled" } }]) {
      const f = fakeContext({ boxHeld: false })
      f.api.on("GET /mcp", { status: 200, data: statuses })
      f.live.value = liveOk
      const result = await invoke(doctorTool, {}, f.ctx)
      expect(data(result)).toMatchObject({ verified: statuses === missing ? false : true })
      if (statuses === missing) expect(text(result)).toContain("ks-seqlogs missing")
    }
  })

  test("review L7: a missing or failing ks-rag-read says rag-read is the owner's private id and how others set their own", async () => {
    for (const status of [undefined, "needs_auth", "failed"]) {
      const f = fakeContext({ boxHeld: false })
      const { ["ks-rag-read"]: _gone, ...rest } = CHOSEN
      f.api.on("GET /mcp", { status: 200, data: status === undefined ? rest : { ...CHOSEN, "ks-rag-read": { status } } })
      f.live.value = liveOk
      const result = await invoke(doctorTool, {}, f.ctx)
      expect(data(result)).toMatchObject({ verified: false })
      expect(text(result)).toContain("`rag-read` is the owner's private Keystone connection id")
      expect(text(result)).toContain("OPENCODE_DELEGATE_KEYSTONE and OPENCODE_DELEGATE_KEYSTONE_ALLOWED")
    }
    const f = fakeContext({ boxHeld: false })
    f.api.on("GET /mcp", { status: 200, data: CHOSEN })
    f.live.value = liveOk
    expect(text(await invoke(doctorTool, {}, f.ctx))).not.toContain("private Keystone connection id")
  })

  test("entries removed earlier are reported by name (Keystone cannot revoke them for the bridge)", async () => {
    const f = fakeContext({ boxHeld: false })
    f.api.on("GET /mcp", { status: 200, data: CHOSEN })
    f.live.value = { ...liveOk, signIns: { ...liveOk.signIns, removedBefore: [{ name: "ks-delegate", clientId: "dcr-0226f1c0", server: "/mcp/dynamic", hadRefresh: true, at: "2026-10-01T00:00:00.000Z" }] } }
    const result = await invoke(doctorTool, {}, f.ctx)
    expect(data(result)).toMatchObject({ live: { signIns: { removedBefore: [{ name: "ks-delegate", clientId: "dcr-0226f1c0" }] } } })
    expect(text(result)).toContain("ks-delegate")
  })
})
