// Caps the time-out the model asks for on the shell tool (#249, svc-coding-agent#539).
// The tool takes any positive `timeout` the model sends (packages/opencode/src/tool/shell.ts), so a
// model could hold one turn for 25 minutes. svc-coding-agent sets SBXW_SHELL_MAX_TIMEOUT_MS per
// task. A whole number above 0 turns the cap on; anything else leaves the tool unchanged.
// Imports nothing: the config dir is read-only (supervisor/main.ts, #127). Export only this
// factory: OpenCode loads every function export of a plugin file as a plugin.
export const ShellTimeoutCap = async () => {
  const raw = process.env.SBXW_SHELL_MAX_TIMEOUT_MS ?? ""
  const value = Number(raw)
  const cap = raw.trim() !== "" && Number.isInteger(value) && value > 0 ? value : undefined
  console.log(`[sbxw] shell timeout cap: ${cap === undefined ? "off" : `${cap} ms`}`)
  if (cap === undefined) return {}
  return {
    // The tool id is "bash" for every shell (packages/opencode/src/tool/shell/id.ts).
    "tool.definition": async (input: { toolID: string }, output: { description: string }) => {
      if (input.toolID !== "bash") return
      output.description = `${output.description}\n\nIn this sandbox a timeout above ${cap} ms is lowered to ${cap} ms.`
    },
    // Change the timeout in place: the same args object then reaches the tool
    // (packages/opencode/src/session/tools.ts). Replacing output.args would have no effect.
    "tool.execute.before": async (input: { tool: string; callID: string }, output: { args: { timeout?: unknown } }) => {
      if (input.tool !== "bash") return
      const asked = output.args?.timeout
      if (typeof asked !== "number" || asked <= cap) return
      output.args.timeout = cap
      console.log(`[sbxw] shell timeout lowered: call ${input.callID}, asked ${asked} ms, cap ${cap} ms`)
    },
  }
}
