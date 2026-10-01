// MOD-04 tool list: the core tools (Wave 3 core build) plus the interaction tools (oc_pending,
// oc_answer, oc_post, oc_inbox — Wave 3 interaction build). server.ts registers `allTools`.
import type { z } from "zod"
import { collectTool } from "./collect.ts"
import type { ToolSpec } from "./define.ts"
import { doctorTool } from "./doctor.ts"
import { interactionTools } from "./interaction.ts"
import { loginTool } from "./login.ts"
import { modelsTool } from "./models.ts"
import { restartTool } from "./restart.ts"
import { resultTool } from "./result.ts"
import { sendTool } from "./send.ts"
import { abortTool, listSessionsTool, startSessionTool, statusTool } from "./sessions.ts"
import { eventsTool, waitTool } from "./wait.ts"

type AnyTool = ToolSpec<z.ZodRawShape>

export const coreTools: AnyTool[] = [
  doctorTool,
  loginTool,
  modelsTool,
  startSessionTool,
  sendTool,
  statusTool,
  waitTool,
  eventsTool,
  resultTool,
  collectTool,
  abortTool,
  listSessionsTool,
  restartTool,
]

export function allTools(): AnyTool[] {
  const names = new Set<string>()
  const out: AnyTool[] = []
  for (const tool of [...coreTools, ...interactionTools]) {
    if (names.has(tool.name)) throw new Error(`duplicate tool name ${tool.name}`)
    names.add(tool.name)
    out.push(tool)
  }
  return out
}
