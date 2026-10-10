// D4 stage 1 (owner decision 2026-10-10): task roles pick models from Synapse's LIVE benchmark
// fit data (capabilities.suitability on GET /v1/models). The role vocabulary is discovered from
// Synapse, never hardcoded. No fit data, unknown role, no token: fall back to the normal default
// and say why - a hint never blocks a send, never guesses a model, never offers a retired model.
import { describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"
import { authConfPath, writeAuthConf } from "../src/synapse/auth-conf.ts"
import { registeredModels } from "../src/synapse/models.ts"
import { modelsTool } from "../src/tools/models.ts"
import { bestForRole, pickRoleModel, rolesTable } from "../src/tools/models.ts"
import { sendTool } from "../src/tools/send.ts"
import { startSessionTool } from "../src/tools/sessions.ts"
import { SID, data, fakeContext, invoke, okCmd, ours, record, remoteSession, text, type Fake } from "./tools-core-fixture.ts"

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlLXZhbHVl"

function fakeSynapseFetch(data: unknown, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    seen.push(String(input))
    return new Response(JSON.stringify({ object: "list", data }), { status: 200 })
  }) as typeof fetch
}

const SUITED = [
  { id: "openai/gpt-6-astra", capabilities: { ops: ["chat"], suitability: { code: 0.92, architecture: 0.6 } } },
  { id: "moonshotai/kimi-k3", capabilities: { ops: ["chat"], suitability: { code: 0.7, qa: 0.95 } } },
  { id: "anthropic/claude-opus-5", capabilities: { ops: ["chat"], suitability: { architecture: 0.98, code: 0.8 } } },
  { id: "no-fit-model", capabilities: { ops: ["chat"] } },
  { id: "garbage", capabilities: { ops: ["chat"], suitability: { code: "0.9", "": 0.5, bad: 42 } } },
]

describe("registeredModels D4: suitability parsed, malformed dropped", () => {
  test("keeps per-model role scores; junk scores and empty roles are ignored", async () => {
    const f = fakeContext()
    const frontDir = path.join(f.ctx.config.home, "front")
    await writeAuthConf(frontDir, TOKEN)
    try {
      const got = await registeredModels({ frontDir, fetch: fakeSynapseFetch(SUITED) })
      expect(got.suitability).toEqual({
        "openai/gpt-6-astra": { code: 0.92, architecture: 0.6 },
        "moonshotai/kimi-k3": { code: 0.7, qa: 0.95 },
        "anthropic/claude-opus-5": { architecture: 0.98, code: 0.8 },
      })
    } finally {
      await rm(authConfPath(frontDir), { force: true })
    }
  })
})

describe("bestForRole (pure pick)", () => {
  const offered = ["synapse/anthropic/claude-opus-5", "synapse/auto", "synapse/moonshotai/kimi-k3", "synapse/openai/gpt-6-astra"]
  test("highest score wins; auto never picked; no data for the role gives undefined", () => {
    expect(bestForRole("code", offered, { "openai/gpt-6-astra": { code: 0.92 }, "anthropic/claude-opus-5": { code: 0.8 } }))
      .toEqual({ model: "synapse/openai/gpt-6-astra", score: 0.92 })
    expect(bestForRole("qa", offered, { "moonshotai/kimi-k3": { qa: 0.95 } })).toEqual({ model: "synapse/moonshotai/kimi-k3", score: 0.95 })
    expect(bestForRole("ui", offered, { "openai/gpt-6-astra": { code: 0.92 } })).toBeUndefined()
  })

  test("a model not offered by the box is never picked (hints cannot resurrect a retired model)", () => {
    expect(bestForRole("code", ["synapse/auto", "synapse/other"], { other: { code: 0.1 }, gone: { code: 1 } })).toEqual({ model: "synapse/other", score: 0.1 })
    expect(bestForRole("code", ["synapse/auto"], { gone: { code: 1 } })).toBeUndefined()
  })
})

describe("pickRoleModel (live)", () => {
  test("picks the best offered fit for the role from Synapse's live list", async () => {
    const f = fakeContext()
    const frontDir = path.join(f.ctx.config.home, "front")
    await writeAuthConf(frontDir, TOKEN)
    const orig = globalThis.fetch
    globalThis.fetch = fakeSynapseFetch(SUITED)
    try {
      const pick = await pickRoleModel(f.ctx, "architecture", ["synapse/auto", "synapse/openai/gpt-6-astra", "synapse/anthropic/claude-opus-5"])
      expect(pick).toEqual({ model: "synapse/anthropic/claude-opus-5", score: 0.98 })
    } finally {
      globalThis.fetch = orig
      await rm(authConfPath(frontDir), { force: true })
    }
  })

  test("unknown role names the known ones and falls back; no token falls back with its reason", async () => {
    const f = fakeContext()
    const frontDir = path.join(f.ctx.config.home, "front")
    await writeAuthConf(frontDir, TOKEN)
    const orig = globalThis.fetch
    globalThis.fetch = fakeSynapseFetch(SUITED)
    try {
      const unknown = await pickRoleModel(f.ctx, "ui", ["synapse/auto", "synapse/openai/gpt-6-astra"])
      expect("none" in unknown ? unknown.none : "").toContain('role "ui"')
      expect("none" in unknown ? unknown.none : "").toContain("architecture")
    } finally {
      globalThis.fetch = orig
      await rm(authConfPath(frontDir), { force: true })
    }
    const noToken = await pickRoleModel(f.ctx, "code", ["synapse/auto"])
    expect("none" in noToken ? noToken.none : "").toContain("no host-held Synapse token")
  })
})

describe("oc_list_models reports the discovered roles", () => {
  test("roles keys are exactly what Synapse publishes; ranked, capped, offered-only", async () => {
    const f = fakeContext()
    const frontDir = path.join(f.ctx.config.home, "front")
    await writeAuthConf(frontDir, TOKEN)
    f.api.on("GET /config/providers", { status: 200, data: { providers: [{ id: "synapse", models: { auto: { id: "auto" }, "openai/gpt-6-astra": { id: "openai/gpt-6-astra" }, "moonshotai/kimi-k3": { id: "moonshotai/kimi-k3" }, "anthropic/claude-opus-5": { id: "anthropic/claude-opus-5" } } }] } })
    f.api.on("GET /config", { status: 200, data: { model: "synapse/auto" } })
    const orig = globalThis.fetch
    globalThis.fetch = fakeSynapseFetch(SUITED)
    try {
      const result = await invoke(modelsTool, {}, f.ctx)
      const roles = data(result).roles as Record<string, Array<{ model: string; score: number }>>
      expect(Object.keys(roles).sort()).toEqual(["architecture", "code", "qa"])
      expect(roles["code"]?.[0]).toEqual({ model: "synapse/openai/gpt-6-astra", score: 0.92 })
      expect(roles["qa"]).toEqual([{ model: "synapse/moonshotai/kimi-k3", score: 0.95 }])
      expect(text(result)).toContain("Roles with fit data")
    } finally {
      globalThis.fetch = orig
      await rm(authConfPath(frontDir), { force: true })
    }
  })

  test("no suitability data: no roles field at all (the hint fails open)", async () => {
    const f = fakeContext()
    f.api.on("GET /config/providers", { status: 200, data: { providers: [{ id: "synapse", models: { auto: { id: "auto" } } }] } })
    f.api.on("GET /config", { status: 200, data: { model: "synapse/auto" } })
    const result = await invoke(modelsTool, {}, f.ctx)
    expect(data(result).roles).toBeUndefined()
  })
})

function readySend(f: Fake, offeredModels: string[]) {
  ours(f)
  f.api.on(`GET /session/${SID}`, { status: 200, data: remoteSession(f) })
  f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "connected" } } })
  f.api.on(`POST /session/${SID}/prompt_async`, { status: 204 })
  f.api.on("GET /config/providers", { status: 200, data: { providers: [{ id: "synapse", models: Object.fromEntries(offeredModels.map((m) => [m, { id: m }])) }] } })
  f.api.on("GET /config", { status: 200, data: { model: "synapse/auto" } })
}

describe("oc_send taskRole D4", () => {
  test("the pick is sent as the model and reported in taskPick", async () => {
    const f = fakeContext()
    readySend(f, ["auto", "openai/gpt-6-astra", "anthropic/claude-opus-5"])
    const frontDir = path.join(f.ctx.config.home, "front")
    await writeAuthConf(frontDir, TOKEN)
    const orig = globalThis.fetch
    globalThis.fetch = fakeSynapseFetch(SUITED)
    try {
      const result = await invoke(sendTool, { sessionID: SID, message: "build it", taskRole: "code" }, f.ctx)
      expect(data(result)).toMatchObject({ accepted: true, taskPick: { role: "code", model: "synapse/openai/gpt-6-astra", score: 0.92 } })
      expect(f.api.find("POST", `/session/${SID}/prompt_async`)?.body).toMatchObject({ model: { providerID: "synapse", modelID: "openai/gpt-6-astra" } })
      expect(text(result)).toContain("Model for role")
    } finally {
      globalThis.fetch = orig
      await rm(authConfPath(frontDir), { force: true })
    }
  })

  test("explicit model beats taskRole; unknown role sends the default and says why", async () => {
    const f = fakeContext()
    readySend(f, ["auto", "openai/gpt-6-astra"])
    f.api.on("GET /config/providers", { status: 200, data: { providers: [{ id: "synapse", models: { auto: { id: "auto" } } }] } })
    const frontDir = path.join(f.ctx.config.home, "front")
    await writeAuthConf(frontDir, TOKEN)
    const orig = globalThis.fetch
    globalThis.fetch = fakeSynapseFetch(SUITED)
    try {
      const explicit = await invoke(sendTool, { sessionID: SID, message: "m", model: "synapse/auto", taskRole: "code" }, f.ctx)
      expect(data(explicit).taskPick).toBeUndefined()
      const fallback = await invoke(sendTool, { sessionID: SID, message: "m", taskRole: "ui" }, f.ctx)
      const pick = data(fallback).taskPick as { role: string; fellBack: string }
      expect(pick.role).toBe("ui")
      expect(pick.fellBack).toContain("no fit data")
      const calls = f.api.calls.filter((c) => c.path.endsWith("prompt_async"))
      expect(calls.at(-1)?.body).toMatchObject({ model: { providerID: "synapse", modelID: "auto" } })
    } finally {
      globalThis.fetch = orig
      await rm(authConfPath(frontDir), { force: true })
    }
  })
})

describe("oc_start_session taskRole D4", () => {
  test("the session's default model becomes the picked fit", async () => {
    const f = fakeContext()
    f.api.on("POST /session", { status: 200, data: { id: SID } })
    f.api.on("GET /mcp", { status: 200, data: { "ks-rag-read": { status: "connected" } } })
    f.api.on("GET /config/providers", { status: 200, data: { providers: [{ id: "synapse", models: { auto: { id: "auto" }, "openai/gpt-6-astra": { id: "openai/gpt-6-astra" } } }] } })
    f.api.on("GET /config", { status: 200, data: { model: "synapse/auto" } })
    const frontDir = path.join(f.ctx.config.home, "front")
    await writeAuthConf(frontDir, TOKEN)
    const orig = globalThis.fetch
    globalThis.fetch = fakeSynapseFetch(SUITED)
    try {
      const result = await invoke(startSessionTool, { directory: "C:\\GitHub\\demo", taskRole: "code" }, f.ctx)
      expect(data(result)).toMatchObject({ taskPick: { model: "synapse/openai/gpt-6-astra", score: 0.92 } })
      expect(f.ctx.sessions.get(SID)?.model).toBe("synapse/openai/gpt-6-astra")
    } finally {
      globalThis.fetch = orig
      await rm(authConfPath(frontDir), { force: true })
    }
  })
})
