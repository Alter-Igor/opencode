/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { heapStats } from "bun:jsc"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { mount, wait } from "./sync-fixture"

const count = 20
const size = 1024 * 1024

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

function info(n: number) {
  return {
    id: `ses_evict_${n}`,
    slug: `evict-${n}`,
    projectID: "proj_test",
    title: `evict ${n}`,
    time: { created: n, updated: n },
    version: "1.15.13",
    directory: "/tmp/opencode/packages/opencode",
  }
}

function assistant(n: number) {
  return {
    id: `msg_evict_${n}`,
    sessionID: `ses_evict_${n}`,
    role: "assistant" as const,
    agent: "build",
    modelID: "model",
    providerID: "test",
    mode: "build",
    parentID: "msg_user",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: n, completed: n + 1 },
  }
}

async function heap() {
  Bun.gc(true)
  await Bun.sleep(20)
  Bun.gc(true)
  const stats = heapStats()
  return stats.heapSize + stats.extraMemorySize
}

test("deleting a session releases its messages, parts and per-session state", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)

  try {
    const before = await heap()
    for (let n = 0; n < count; n++) {
      const sessionID = `ses_evict_${n}`
      emit(global({ id: `evt_s${n}`, type: "session.updated", properties: { sessionID, info: info(n) } }))
      emit(global({ id: `evt_m${n}`, type: "message.updated", properties: { sessionID, info: assistant(n) } }))
      emit(
        global({
          id: `evt_p${n}`,
          type: "message.part.updated",
          properties: {
            sessionID,
            time: n,
            part: {
              id: `prt_evict_${n}`,
              sessionID,
              messageID: `msg_evict_${n}`,
              type: "text",
              // unique per session so the engine cannot share one string
              text: `${n}:`.padEnd(size, "x"),
            },
          },
        }),
      )
    }
    await wait(() => Object.keys(sync.data.part).length === count)
    const loaded = await heap()

    for (let n = 0; n < count; n++) {
      const sessionID = `ses_evict_${n}`
      emit(global({ id: `evt_d${n}`, type: "session.deleted", properties: { sessionID, info: info(n) } }))
    }
    await wait(() => sync.data.session.every((s) => !s.id.startsWith("ses_evict_")))
    const after = await heap()

    console.log(
      `heap MB before=${(before / 1048576).toFixed(1)} loaded=${(loaded / 1048576).toFixed(1)} afterDelete=${(after / 1048576).toFixed(1)}`,
    )
    expect(Object.keys(sync.data.message).filter((id) => id.startsWith("ses_evict_"))).toEqual([])
    expect(Object.keys(sync.data.part).filter((id) => id.startsWith("msg_evict_"))).toEqual([])
    // The fixture event source keeps its own copy of every emitted event, so compare against the loaded size, not the start.
    // Measured: ~40 MB released of ~120 MB added for 20 MB of text.
    expect(loaded - after).toBeGreaterThan((count * size) / 2)
  } finally {
    app.renderer.destroy()
  }
})
