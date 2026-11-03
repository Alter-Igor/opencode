// MOD-04 tool list: the core tools (Wave 3 core build), interaction tools (Wave 3 interaction build),
// and the 1-step delegate_task tool. Automatically provides clean `code_*` aliases for all `oc_*` tools.
import type { z } from "zod"
import { cleanupTool, closeSessionTool } from "./close-session.ts"
import { collectTool } from "./collect.ts"
import { dashboardTool } from "./dashboard.ts"
import type { ToolSpec } from "./define.ts"
import { delegateTaskTool } from "./delegate-task.ts"
import { doctorTool } from "./doctor.ts"
import { interactionTools } from "./interaction.ts"
import { loginTool } from "./login.ts"
import { modelsTool } from "./models.ts"
import { reportTool } from "./report.ts"
import { restartTool } from "./restart.ts"
import { resultTool } from "./result.ts"
import { sendTool } from "./send.ts"
import { abortTool, listSessionsTool, startSessionTool, statusTool } from "./sessions.ts"
import { syncTool } from "./sync.ts"
import { verifyTool } from "./verify.ts"
import { landTool } from "./land.ts"
import { eventsTool, waitTool } from "./wait.ts"

type AnyTool = ToolSpec<z.ZodRawShape>

export function createAlias<S extends z.ZodRawShape>(tool: ToolSpec<S>, newName: string): ToolSpec<S> {
  return {
    ...tool,
    name: newName,
    title: `${tool.title} (alias: ${newName})`,
  }
}

export { delegateTaskTool }

export const coreTools: AnyTool[] = [
  delegateTaskTool,
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
  syncTool,
  verifyTool,
  landTool,
  abortTool,
  listSessionsTool,
  closeSessionTool,
  cleanupTool,
  reportTool,
  dashboardTool,
  restartTool,
]

export function allTools(): AnyTool[] {
  const names = new Set<string>()
  const out: AnyTool[] = []
  const baseTools: AnyTool[] = [...coreTools, ...interactionTools]

  for (const tool of baseTools) {
    if (names.has(tool.name)) throw new Error(`duplicate tool name ${tool.name}`)
    names.add(tool.name)
    out.push(tool)

    // Automatically generate code_* aliases for oc_* tools
    if (tool.name.startsWith("oc_")) {
      const aliasName = tool.name.replace(/^oc_/, "code_")
      if (!names.has(aliasName)) {
        names.add(aliasName)
        out.push(createAlias(tool, aliasName))
      }
    } else if (tool.name === "delegate_task") {
      const aliasName = "code_delegate_task"
      if (!names.has(aliasName)) {
        names.add(aliasName)
        out.push(createAlias(tool, aliasName))
      }
    }
  }
  return out
}
