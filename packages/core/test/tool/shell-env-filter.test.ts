// #203: child shell environment scrubbing in default and OPENCODE_SHELL_STRIP_ALL_TOKENS modes.
import { describe, expect, test } from "bun:test"
import { scrubShellEnv } from "../../src/tool/shell-env-filter"

describe("scrubShellEnv (#203)", () => {
  test("always strips internal OpenCode, Keystone, Synapse, and LLM provider keys while keeping developer CLI tokens by default", () => {
    const input: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/dev",
      GH_TOKEN: "ghp_dev_token",
      GITHUB_TOKEN: "ghp_github_token",
      GITLAB_TOKEN: "glpat_gitlab_token",
      NPM_TOKEN: "npm_publish_token",
      AWS_SECRET_ACCESS_KEY: "aws_secret",
      AWS_SESSION_TOKEN: "aws_session",
      CUSTOM_SERVICE_API_KEY: "custom_service_key",
      OPENCODE_MODEL: "anthropic/claude-sonnet-4-5",
      OPENCODE_KEYSTONE_BROKER_KEY: "broker_secret",
      OPENCODE_KEYSTONE_CLIENT_SECRET: "client_secret",
      OPENCODE_AUTH_CONTENT: '{"token":"secret"}',
      OPENCODE_SERVER_PASSWORD: "server_password",
      OPENCODE_CUSTOM_INTERNAL_TOKEN: "internal_token",
      OPENCODE_BRIDGE_SIGNING_KEY: "signing_key",
      OPENCODE_WEBHOOK_SECRET: "webhook_secret",
      OPENCODE_ADMIN_PASSWORD: "admin_password",
      CAS_MCP_TOKEN: "cas_token",
      SYNAPSE_API_KEY: "synapse_key",
      GPAAS_API_KEY: "gpaas_key",
      OPENROUTER_API_KEY: "openrouter_key",
      OPENAI_API_KEY: "openai_key",
      ANTHROPIC_API_KEY: "anthropic_key",
      GEMINI_API_KEY: "gemini_key",
      GOOGLE_GENERATIVE_AI_API_KEY: "google_key",
      XAI_API_KEY: "xai_key",
      DEEPSEEK_API_KEY: "deepseek_key",
      MISTRAL_API_KEY: "mistral_key",
      GROQ_API_KEY: "groq_key",
      TOGETHER_API_KEY: "together_key",
      PERPLEXITY_API_KEY: "perplexity_key",
      COHERE_API_KEY: "cohere_key",
      CEREBRAS_API_KEY: "cerebras_key",
      E2B_API_KEY: "e2b_key",
      SBXW_AUTH_JSON: '{"auth":"secret"}',
      UNDEFINED_VAR: undefined,
    }

    const out = scrubShellEnv(input)

    // Preserved developer CLI and standard environment variables
    expect(out.PATH).toBe("/usr/local/bin:/usr/bin")
    expect(out.HOME).toBe("/home/dev")
    expect(out.GH_TOKEN).toBe("ghp_dev_token")
    expect(out.GITHUB_TOKEN).toBe("ghp_github_token")
    expect(out.GITLAB_TOKEN).toBe("glpat_gitlab_token")
    expect(out.NPM_TOKEN).toBe("npm_publish_token")
    expect(out.AWS_SECRET_ACCESS_KEY).toBe("aws_secret")
    expect(out.AWS_SESSION_TOKEN).toBe("aws_session")
    expect(out.CUSTOM_SERVICE_API_KEY).toBe("custom_service_key")
    expect(out.OPENCODE_MODEL).toBe("anthropic/claude-sonnet-4-5")

    // Stripped internal & provider secrets
    expect(out.OPENCODE_KEYSTONE_BROKER_KEY).toBeUndefined()
    expect(out.OPENCODE_KEYSTONE_CLIENT_SECRET).toBeUndefined()
    expect(out.OPENCODE_AUTH_CONTENT).toBeUndefined()
    expect(out.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(out.OPENCODE_CUSTOM_INTERNAL_TOKEN).toBeUndefined()
    expect(out.OPENCODE_BRIDGE_SIGNING_KEY).toBeUndefined()
    expect(out.OPENCODE_WEBHOOK_SECRET).toBeUndefined()
    expect(out.OPENCODE_ADMIN_PASSWORD).toBeUndefined()
    expect(out.CAS_MCP_TOKEN).toBeUndefined()
    expect(out.SYNAPSE_API_KEY).toBeUndefined()
    expect(out.GPAAS_API_KEY).toBeUndefined()
    expect(out.OPENROUTER_API_KEY).toBeUndefined()
    expect(out.OPENAI_API_KEY).toBeUndefined()
    expect(out.ANTHROPIC_API_KEY).toBeUndefined()
    expect(out.GEMINI_API_KEY).toBeUndefined()
    expect(out.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined()
    expect(out.XAI_API_KEY).toBeUndefined()
    expect(out.DEEPSEEK_API_KEY).toBeUndefined()
    expect(out.MISTRAL_API_KEY).toBeUndefined()
    expect(out.GROQ_API_KEY).toBeUndefined()
    expect(out.TOGETHER_API_KEY).toBeUndefined()
    expect(out.PERPLEXITY_API_KEY).toBeUndefined()
    expect(out.COHERE_API_KEY).toBeUndefined()
    expect(out.CEREBRAS_API_KEY).toBeUndefined()
    expect(out.E2B_API_KEY).toBeUndefined()
    expect(out.SBXW_AUTH_JSON).toBeUndefined()
    expect("UNDEFINED_VAR" in out).toBe(false)
  })

  test("strips ambient credential variables when OPENCODE_SHELL_STRIP_ALL_TOKENS is '1' or 'true'", () => {
    for (const flag of ["1", "true"]) {
      const out = scrubShellEnv({
        OPENCODE_SHELL_STRIP_ALL_TOKENS: flag,
        PATH: "/usr/bin",
        HOME: "/home/dev",
        GH_TOKEN: "gh_tok",
        GITHUB_TOKEN: "github_tok",
        GITLAB_TOKEN: "gitlab_tok",
        NPM_TOKEN: "npm_tok",
        AWS_SECRET_ACCESS_KEY: "aws_sec",
        AWS_SESSION_TOKEN: "aws_sess",
        CUSTOM_API_KEY: "api_k",
        SERVICE_SECRET_KEY: "sec_k",
        MY_ACCESS_TOKEN: "acc_tok",
        APP_AUTH_TOKEN: "auth_tok",
        OAUTH_CLIENT_SECRET: "cli_sec",
        UPSTREAM_BEARER_TOKEN: "bearer_tok",
        DEPLOY_PRIVATE_KEY: "priv_k",
      })

      expect(out.PATH).toBe("/usr/bin")
      expect(out.HOME).toBe("/home/dev")
      expect(out.GH_TOKEN).toBeUndefined()
      expect(out.GITHUB_TOKEN).toBeUndefined()
      expect(out.GITLAB_TOKEN).toBeUndefined()
      expect(out.NPM_TOKEN).toBeUndefined()
      expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined()
      expect(out.AWS_SESSION_TOKEN).toBeUndefined()
      expect(out.CUSTOM_API_KEY).toBeUndefined()
      expect(out.SERVICE_SECRET_KEY).toBeUndefined()
      expect(out.MY_ACCESS_TOKEN).toBeUndefined()
      expect(out.APP_AUTH_TOKEN).toBeUndefined()
      expect(out.OAUTH_CLIENT_SECRET).toBeUndefined()
      expect(out.UPSTREAM_BEARER_TOKEN).toBeUndefined()
      expect(out.DEPLOY_PRIVATE_KEY).toBeUndefined()
    }
  })
})
