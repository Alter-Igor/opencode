import { describe, expect, test } from "bun:test"
import path from "node:path"
import { DelegateError } from "../src/shared/errors.ts"
import {
  PROFILE_GITIGNORE,
  buildProfile,
  hashDirectory,
  permissionConfig,
  readOwnerConfigs,
  stripJsonc,
  writeProfile,
  type ProfileFs,
  type ProfileInput,
} from "../src/supervisor/profile.ts"

const config = { keystoneOrigin: "https://identity.alterspective.com.au", keystoneConnections: ["rag-global", "github", "seqlogs"], boxEnv: ["SYNAPSE_API_KEY"] }
const baseline = [
  { permission: "*", pattern: "*", action: "allow" as const },
  { permission: "external_directory", pattern: "*", action: "deny" as const },
  { permission: "bash", pattern: "*", action: "allow" as const },
  { permission: "bash", pattern: "git push*", action: "ask" as const },
]

function owner(provider: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ model: "synapse/auto", provider, ...extra })
}

const synapse = {
  npm: "@ai-sdk/openai-compatible",
  options: { baseURL: "https://synapse2-api.alterspective.com.au/v1", apiKey: "{env:SYNAPSE_API_KEY}" },
  models: { auto: { name: "auto", limit: { context: 200000, output: 16384 } } },
}

function input(ownerConfigs: string[], over: Partial<ProfileInput> = {}): ProfileInput {
  return { ownerConfigs, config, permission: baseline, ...over }
}

function refusal(fn: () => unknown): DelegateError {
  try {
    fn()
  } catch (error) {
    if (error instanceof DelegateError) return error
    throw error
  }
  throw new Error("expected a DelegateError")
}

type ProfileJson = { provider: Record<string, { options: Record<string, unknown> }>; mcp: unknown; [key: string]: unknown }

function parsedConfig(files: Record<string, string>): ProfileJson {
  return JSON.parse(files["opencode/opencode.json"]!) as ProfileJson
}

describe("profile: secret refusal", () => {
  test("refuses a literal apiKey, naming the key path and never the value", () => {
    const secret = "plainLiteralValue42"
    const text = owner({ synapse: { ...synapse, options: { ...synapse.options, apiKey: secret } } })
    const error = refusal(() => buildProfile(input([text])))
    expect(error.code).toBe("profile_invalid")
    expect(error.message).toContain("provider.synapse.options.apiKey")
    expect(JSON.stringify({ ...error.toResult(), detail: error.detail })).not.toContain(secret)
  })

  test("refuses a literal secret in a non-apiKey slot (headers.Authorization)", () => {
    const text = owner({ synapse: { ...synapse, options: { ...synapse.options, headers: { Authorization: "hunter2hunter2" } } } })
    const error = refusal(() => buildProfile(input([text])))
    expect(error.message).toContain("provider.synapse.options.headers.Authorization")
    expect(error.message).not.toContain("hunter2")
  })

  test("refuses a token-shaped literal even under an innocent key", () => {
    const text = owner({ synapse: { ...synapse, options: { ...synapse.options, note: "gpapp_0123456789abcdef" } } })
    expect(refusal(() => buildProfile(input([text]))).message).toContain("provider.synapse.options.note")
  })

  test("refuses {file:...} references", () => {
    const text = owner({ synapse: { ...synapse, options: { ...synapse.options, apiKey: "{file:~/.secrets/key}" } } })
    const error = refusal(() => buildProfile(input([text])))
    expect(error.code).toBe("profile_invalid")
    expect(error.message).toContain("{file:...}")
    expect(error.message).toContain("provider.synapse.options.apiKey")
    expect(error.message).not.toContain(".secrets")
  })

  test("accepts 'Bearer {env:NAME}' and numeric *Tokens limits", () => {
    const opts = { ...synapse.options, headers: { Authorization: "Bearer {env:SYNAPSE_API_KEY}" }, maxTokens: 4096 }
    const built = buildProfile(input([owner({ synapse: { ...synapse, options: opts } })]))
    expect(built.providers).toEqual(["synapse"])
  })
})

// A-03: the scan fails closed. Each shape below was accepted by the Wave 1 scanner.
describe("profile: fail-closed secret shapes (A-03)", () => {
  const shapes: Array<[string, Record<string, unknown>, string]> = [
    ["custom auth header literal", { headers: { "X-Custom-Auth": "plainvalue123" } }, "headers.X-Custom-Auth"],
    ["any literal header value", { headers: { "X-Trace": "abc" } }, "headers.X-Trace"],
    ["APIM subscription key", { headers: { "Ocp-Apim-Subscription-Key": "0123abcd0123abcd" } }, "headers.Ocp-Apim-Subscription-Key"],
    ["AWS access key id field", { accessKeyId: "ANYVALUE0000" }, "options.accessKeyId"],
    ["Google API key value", { region: "AIzaSyA-0123456789abcdefghijklmnopqrstu" }, "options.region"],
    ["AWS key value", { region: "AKIAIOSFODNN7EXAMPLE" }, "options.region"],
    ["JWT value", { note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig" }, "options.note"],
    ["userinfo in baseURL", { baseURL: "https://user:pass@synapse2-api.alterspective.com.au/v1" }, "options.baseURL"],
    ["numeric apiKey", { apiKey: 1234567890 }, "options.apiKey"],
    ["numeric header", { headers: { "X-Key": 42 } }, "headers.X-Key"],
    ["object under a secret key", { auth: { value: "hunter2hunter2" } }, "options.auth.value"],
    ["key in a query string", { baseURL: "https://x.example/v1?api-key=abc123" }, "options.baseURL"],
    ["token field", { accessToken: "opaque-value" }, "options.accessToken"],
  ]
  for (const [name, extra, where] of shapes) {
    test(`refuses ${name}`, () => {
      const text = owner({ synapse: { ...synapse, options: { ...synapse.options, ...extra } } })
      const error = refusal(() => buildProfile(input([text])))
      expect(error.code).toBe("profile_invalid")
      expect(error.message).toContain(where)
      for (const value of JSON.stringify(extra).match(/"[^"]{6,}"/g) ?? []) {
        const literal = value.slice(1, -1)
        if (!where.includes(literal)) expect(error.message).not.toContain(literal)
      }
    })
  }

  test("still accepts env refs in headers, booleans in secret slots and model ids that look like keys", () => {
    const opts = { ...synapse.options, headers: { "X-Api-Key": "{env:SYNAPSE_API_KEY}" }, useAuth: true }
    const models = { ...synapse.models, "token-counter": { name: "t", limit: { context: 1, output: 1 } } }
    const built = buildProfile(input([owner({ synapse: { ...synapse, options: opts, models } })]))
    expect(built.providers).toEqual(["synapse"])
  })
})

describe("profile: merge across owner files (A-21)", () => {
  test("later files merge into provider entries instead of replacing them", () => {
    const first = owner({ synapse })
    const second = JSON.stringify({ provider: { synapse: { options: { timeout: 60000 } } } })
    const cfg = parsedConfig(buildProfile(input([first, second])).files)
    expect(cfg.provider.synapse!.options).toEqual({ ...synapse.options, timeout: 60000 })
    expect((cfg.provider.synapse as unknown as { models: unknown }).models).toEqual(synapse.models)
  })
})

describe("profile: selection", () => {
  test("copies only provider/model/small_model and drops providers whose env is not approved", () => {
    const openrouter = { options: { apiKey: "{env:OPENROUTER_API_KEY}" } }
    const text = owner({ synapse, openrouter }, { small_model: "openrouter/x", mcp: { rag: { type: "remote", url: "https://rag.example" } }, instructions: ["a.md"] })
    const built = buildProfile(input([text]))
    const cfg = parsedConfig(built.files)
    expect(Object.keys(cfg).sort()).toEqual(["$schema", "mcp", "model", "permission", "provider"])
    expect(Object.keys(cfg.provider)).toEqual(["synapse"])
    expect(built.dropped).toContainEqual({ provider: "openrouter", reason: "needs OPENROUTER_API_KEY (not on the approved box env list)" })
    expect(built.dropped.map((d) => d.provider)).toContain("small_model")
  })

  test("keeps a provider that needs no key and can inject an approved key env", () => {
    const keyless = { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://synapse2-api.alterspective.com.au/v1" } }
    const built = buildProfile(input([owner({ synapse: keyless })], { keyEnv: { synapse: "SYNAPSE_API_KEY" } }))
    expect(parsedConfig(built.files).provider.synapse!.options.apiKey).toBe("{env:SYNAPSE_API_KEY}")
    const plain = buildProfile(input([owner({ synapse: keyless })]))
    expect(parsedConfig(plain.files).provider.synapse!.options.apiKey).toBeUndefined()
  })

  test("refuses a default model whose provider is not in the box", () => {
    const text = JSON.stringify({ model: "openrouter/x", provider: { openrouter: { options: { apiKey: "{env:OPENROUTER_API_KEY}" } } } })
    expect(refusal(() => buildProfile(input([text]))).code).toBe("profile_invalid")
  })

  test("mcp holds one ks-<id> → /mcp/c/<id> entry per chosen connection, and no /mcp/dynamic (R4-01)", () => {
    const built = buildProfile(input([owner({ synapse })]))
    expect(parsedConfig(built.files).mcp).toEqual({
      "ks-rag-global": { type: "remote", url: "https://identity.alterspective.com.au/mcp/c/rag-global" },
      "ks-github": { type: "remote", url: "https://identity.alterspective.com.au/mcp/c/github" },
      "ks-seqlogs": { type: "remote", url: "https://identity.alterspective.com.au/mcp/c/seqlogs" },
    })
    expect(JSON.stringify(parsedConfig(built.files))).not.toContain("dynamic")
    for (const bad of ["../x", "Rag", "a_b", "dynamic|x"])
      expect(refusal(() => buildProfile(input([owner({ synapse })], { config: { ...config, keystoneConnections: [bad] } }))).code).toBe("profile_invalid")
  })

  test("always writes the .gitignore OpenCode would otherwise crash writing", () => {
    const built = buildProfile(input([owner({ synapse })]))
    expect(built.files["opencode/.gitignore"]).toBe(PROFILE_GITIGNORE)
    expect(PROFILE_GITIGNORE.trim().split("\n")).toEqual(["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"])
  })

  test("permission rules keep order and collapse single '*' rules to strings", () => {
    expect(permissionConfig(baseline)).toEqual({ "*": "allow", external_directory: "deny", bash: { "*": "allow", "git push*": "ask" } })
  })
})

describe("profile: JSONC", () => {
  test("strips comments and trailing commas but not // inside strings", () => {
    const text = `{
      // line comment
      "model": "synapse/auto", /* block */
      "provider": { "synapse": { "options": { "baseURL": "https://x.example/v1", "apiKey": "{env:SYNAPSE_API_KEY}", }, }, },
    }`
    expect(JSON.parse(stripJsonc(text)).provider.synapse.options.baseURL).toBe("https://x.example/v1")
    expect(buildProfile(input([text])).providers).toEqual(["synapse"])
  })

  test("invalid JSON is profile_invalid", () => {
    expect(refusal(() => buildProfile(input(["{ nope"]))).code).toBe("profile_invalid")
  })
})

function memoryFs(): ProfileFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  const norm = (p: string) => p.split(path.sep).join("/")
  return {
    files,
    readText: async (file) => files.get(norm(file)),
    writeText: async (file, text) => void files.set(norm(file), text),
    remove: async (file) => void files.delete(norm(file)),
    listFiles: async (root) =>
      [...files.keys()].filter((key) => key.startsWith(norm(root) + "/")).map((key) => key.slice(norm(root).length + 1)),
  }
}

describe("profile: hash + write", () => {
  test("hash is stable for the same input and changes when the profile changes", () => {
    const a = buildProfile(input([owner({ synapse })]))
    const b = buildProfile(input([owner({ synapse })]))
    expect(a.hash).toBe(b.hash)
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
    const c = buildProfile(input([owner({ synapse })], { permission: baseline.slice(0, 2) }))
    expect(c.hash).not.toBe(a.hash)
    const d = buildProfile(input([owner({ synapse })], { config: { ...config, keystoneConnections: ["rag-global"] } }))
    expect(d.hash).not.toBe(a.hash)
  })

  test("writeProfile replaces stale files and the on-disk hash equals the built hash", async () => {
    const fs = memoryFs()
    const root = path.join("home", "profile")
    await fs.writeText(path.join(root, "opencode", "stale.json"), "{}")
    const built = buildProfile(input([owner({ synapse })]))
    expect(await writeProfile(fs, root, built.files)).toBe(built.hash)
    expect([...fs.files.keys()].some((key) => key.endsWith("stale.json"))).toBe(false)
    await fs.writeText(path.join(root, "opencode", "extra.txt"), "x")
    expect(await hashDirectory(fs, root)).not.toBe(built.hash)
  })

  test("readOwnerConfigs reads the global files in OpenCode load order", async () => {
    const fs = memoryFs()
    await fs.writeText(path.join("cfg", "opencode.jsonc"), "c")
    await fs.writeText(path.join("cfg", "config.json"), "a")
    expect(await readOwnerConfigs(fs, "cfg")).toEqual(["a", "c"])
  })
})
