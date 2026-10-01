// oc_list_models: the models the sandbox's profile offers, from GET /config/providers
// (packages/opencode/src/server/routes/instance/httpapi/groups/config.ts). Ids are box data, so
// only ids that look like ids are passed on.
// It also lists the box-wide Keystone services (R4-01): this is the call a client makes before
// oc_start_session to pick `model`, so it sees the ids valid for `keystone` in the same answer.
import { z } from "zod"
import { DelegateError } from "../shared/errors.ts"
import type { OpencodeApi } from "../shared/opencode-api.ts"
import { MODEL_RE } from "./core-session.ts"
import { defineTool } from "./define.ts"
import { keystoneLine, keystoneReport } from "./keystone-report.ts"
import { ok } from "./shape.ts"

const PROVIDER_RE = /^[A-Za-z0-9._-]{1,64}$/
const MAX_MODELS = 300

type ProvidersBody = { providers?: Array<{ id?: unknown; models?: Record<string, { id?: unknown }> }>; default?: Record<string, unknown> }

export type ModelList = { models: string[]; defaults: string[] }

export async function fetchModels(api: OpencodeApi, correlationId: string): Promise<ModelList> {
  const res = await api.call<ProvidersBody>({ path: "/config/providers", directory: "/sessions", correlationId })
  if (res.status !== 200 || !Array.isArray(res.data?.providers))
    throw new DelegateError("upstream_error", "The delegate server failed to list its models.", "Retry; if it repeats, run oc_doctor.", `HTTP ${res.status}`)
  const models: string[] = []
  for (const provider of res.data.providers) {
    if (typeof provider.id !== "string" || !PROVIDER_RE.test(provider.id)) continue
    for (const [key, model] of Object.entries(provider.models ?? {})) {
      const id = `${provider.id}/${typeof model?.id === "string" ? model.id : key}`
      if (MODEL_RE.test(id) && models.length < MAX_MODELS) models.push(id)
    }
  }
  const defaults = Object.entries(res.data.default ?? {})
    .map(([p, m]) => `${p}/${String(m)}`)
    .filter((id) => MODEL_RE.test(id))
  return { models: models.sort(), defaults }
}

/**
 * Unknown model → refused (edge case 8). The ids are box data, so they are not put in the error
 * message (W3C-09): oc_list_models returns them as data.
 */
export async function requireModel(api: OpencodeApi, model: string, correlationId: string): Promise<void> {
  const { models } = await fetchModels(api, correlationId)
  if (models.includes(model)) return
  throw new DelegateError("invalid_input", `The sandbox has no model ${model} (${models.length} model${models.length === 1 ? "" : "s"} available).`, "Call oc_list_models and pick one of its ids, for example synapse/auto.")
}

export const modelsTool = defineTool({
  name: "oc_list_models",
  title: "List sandbox models",
  description:
    "List the models the sandbox can use, as provider/model ids (pass one as `model` to oc_start_session or oc_send), and the Keystone services it can use (`keystone.connections`: pass a subset as `keystone` to oc_start_session; change the set with oc_server_restart). Starts the sandbox if it is not running.",
  input: { provider: z.string().regex(PROVIDER_RE).optional().describe("Only this provider, e.g. synapse.") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(args, ctx, correlationId) {
    const box = await ctx.box()
    const list = await fetchModels(box.api, correlationId)
    const models = args.provider ? list.models.filter((m) => m.startsWith(`${args.provider}/`)) : list.models
    const keystone = keystoneReport(ctx.config)
    return ok(`${models.length} model${models.length === 1 ? "" : "s"}${args.provider ? ` from ${args.provider}` : ""}. ${keystoneLine(keystone)}.`, { models, defaults: list.defaults, keystone })
  },
})
