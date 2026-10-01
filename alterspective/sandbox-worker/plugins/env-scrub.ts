// Blanks sandbox control secrets in every shell the agent runs (bash tool, `!` commands, PTY).
// This is hygiene, not a boundary: the agent runs as the same user as the OpenCode server and
// can still read that process's environment through /proc. The boundary is that the sandbox
// holds nothing worth stealing (ADR-037 decision 3).
const SCRUB = ["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME", "SBXW_MODEL_KEY", "SBXW_TASK_TOKEN"]

export const EnvScrub = async () => ({
  "shell.env": async (_input: unknown, output: { env: Record<string, string> }) => {
    for (const key of SCRUB) output.env[key] = ""
  },
})
