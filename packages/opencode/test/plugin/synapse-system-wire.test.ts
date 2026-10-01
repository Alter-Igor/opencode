import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { generateText } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { ProviderTransform } from "@/provider/transform"
import { LLMRequestPrep } from "@/session/llm/request"
import { SynapseAuthPlugin } from "../../src/plugin/synapse"

// The delegate box authenticates Synapse from config (`apiKey: {env:SYNAPSE_API_KEY}`), so
// there is no stored `synapse` auth entry and the plugin auth loader (and its fetch wrapper,
// which runs normalizeSystemMessages) never runs. The system prompt must still reach the
// wire as ONE leading system message, because vLLM backends reject a second one with
// "System message must be at the beginning."

const synapseModel = {
  id: "auto",
  providerID: "synapse",
  api: { id: "auto", url: "https://synapse.example/v1", npm: "@ai-sdk/openai-compatible" },
  name: "Synapse Auto",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200000, output: 16384 },
  status: "active",
  options: {},
  headers: {},
} as any

async function sendThroughSessionPath(small: boolean) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-wire-"))
  const hooks = await SynapseAuthPlugin({
    client: {} as never,
    project: {} as never,
    directory: dir,
    worktree: dir,
    experimental_workspace: { register() {} },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  } as any)

  const plugin = {
    trigger: (name: string, input: unknown, output: unknown) =>
      Effect.promise(async () => {
        const hook = (hooks as any)[name]
        if (hook) await hook(input, output)
        return output
      }),
    list: () => Effect.succeed([hooks]),
    init: () => Effect.void,
  } as any

  const sessionID = "ses_wire_test"
  const prepared = await Effect.runPromise(
    LLMRequestPrep.prepare({
      user: {
        id: "msg_user-test",
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "synapse", modelID: "auto" },
      } as any,
      sessionID,
      model: synapseModel,
      agent: { name: "build", mode: "primary", options: {}, permission: [] } as any,
      system: ["<env>working directory: /sessions</env>"],
      messages: [{ role: "user", content: "Say hello" }],
      small,
      tools: {},
      provider: { id: "synapse", options: {} } as any,
      auth: undefined,
      plugin,
      flags: { outputTokenMax: 32_000, client: "test" } as any,
      isWorkflow: false,
    }),
  )

  let sent: Array<{ role: string; content: unknown }> = []
  const fakeFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)).messages
    // Mirror the vLLM chat-template rule the live gateway enforces.
    if (sent.some((m, i) => m.role === "system" && i > 0)) {
      return new Response(
        JSON.stringify({
          error: {
            message: "System message must be at the beginning.",
            type: "invalid_request_error",
            code: "invalid_request",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )
    }
    return new Response(
      JSON.stringify({
        id: "cmpl-1",
        object: "chat.completion",
        created: 0,
        model: "auto",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }

  // Same provider package and config shape as the box profile (no plugin fetch wrapper).
  const language = createOpenAICompatible({
    name: "synapse",
    baseURL: "https://synapse.example/v1",
    apiKey: "test-key",
    fetch: fakeFetch as any,
  }).chatModel("auto")

  const result = await generateText({
    model: language,
    messages: ProviderTransform.message(prepared.messages, synapseModel, prepared.messageTransformOptions),
    maxRetries: 0,
  })
    .then((r) => ({ ok: true as const, text: r.text }))
    .catch((error: Error) => ({ ok: false as const, error: error.message }))

  await fs.rm(dir, { recursive: true, force: true })
  return { prepared, sent, result }
}

describe("synapse system prompt on the wire (config apiKey, no stored auth)", () => {
  for (const small of [false, true]) {
    test(`sends exactly one leading system message (small=${small})`, async () => {
      const { sent, result } = await sendThroughSessionPath(small)
      expect(sent.map((m) => m.role)).toEqual(["system", "user"])
      expect(result).toEqual({ ok: true, text: "hello" })
      // Nothing the plugin injects is lost when folded into one message.
      const system = String(sent[0].content)
      expect(system).toContain("<env>working directory: /sessions</env>")
      expect(system).toContain("Mandatory Keystone Dynamic MCP Gateway Instructions")
    })
  }
})
