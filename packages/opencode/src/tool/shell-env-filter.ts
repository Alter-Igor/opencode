// Fork (#203): strip internal OpenCode/Keystone/Synapse/provider secrets from child shell environments.
// Developer CLI variables (GH_TOKEN, GITHUB_TOKEN, PATH, HOME, etc.) remain available unless
// OPENCODE_SHELL_STRIP_ALL_TOKENS=1 (or "true") is set.

const INTERNAL_SECRET_NAMES = new Set([
  "OPENCODE_KEYSTONE_BROKER_KEY",
  "OPENCODE_KEYSTONE_CLIENT_SECRET",
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_SERVER_PASSWORD",
  "CAS_MCP_TOKEN",
  "SYNAPSE_API_KEY",
  "GPAAS_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY",
  "PERPLEXITY_API_KEY",
  "COHERE_API_KEY",
  "CEREBRAS_API_KEY",
  "E2B_API_KEY",
  "SBXW_AUTH_JSON",
])

const INTERNAL_SECRET_PATTERN = /^OPENCODE_.*_(?:KEY|SECRET|TOKEN|PASSWORD)$/i

const AMBIENT_TOKEN_PATTERN =
  /(?:_API_KEY|_SECRET_KEY|_ACCESS_TOKEN|_AUTH_TOKEN|_CLIENT_SECRET|_BEARER_TOKEN|_PRIVATE_KEY|^GH_TOKEN$|^GITHUB_TOKEN$|^GITLAB_TOKEN$|^NPM_TOKEN$|^AWS_SECRET_ACCESS_KEY$|^AWS_SESSION_TOKEN$)/i

export function scrubShellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const stripAll = isStripAllEnabled(env)
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue
    if (shouldStripEnvKey(key, stripAll)) continue
    out[key] = value
  }
  return out
}

function isStripAllEnabled(env: NodeJS.ProcessEnv): boolean {
  const direct = env.OPENCODE_SHELL_STRIP_ALL_TOKENS
  if (direct === "1" || direct?.toLowerCase() === "true") return true
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === "OPENCODE_SHELL_STRIP_ALL_TOKENS") {
      return value === "1" || value?.toLowerCase() === "true"
    }
  }
  return false
}

function shouldStripEnvKey(key: string, stripAll: boolean): boolean {
  const upper = key.toUpperCase()
  if (INTERNAL_SECRET_NAMES.has(upper)) return true
  if (INTERNAL_SECRET_PATTERN.test(upper)) return true
  if (stripAll && AMBIENT_TOKEN_PATTERN.test(upper)) return true
  return false
}
