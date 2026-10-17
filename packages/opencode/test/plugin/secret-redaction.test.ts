// #26: credentials in tool output are hidden before the session store keeps them.
// Fixtures are assembled at run time so this file never holds a string that looks like a real
// key to a secret scanner (GitHub push protection, gitleaks).
import { describe, expect, test } from "bun:test"
import { redactSecrets, redactToolResult } from "../../src/plugin/secret-redaction"
import { redactSensitiveData } from "../../src/plugin/observer"

const fake = (prefix: string, body: string, length: number) => prefix + body.repeat(Math.ceil(length / body.length)).slice(0, length)

const KEYS: Record<string, string> = {
  openrouter: fake("sk-" + "or-v1-", "5a5f0c", 64),
  anthropic: fake("sk-" + "ant-api03-", "Ab9_", 90),
  openai: fake("sk-" + "proj-", "Q7xZ", 48),
  github: fake("gh" + "p_", "aB3dE", 36),
  aws: fake("AK" + "IA", "QWERTY23", 16),
  google: fake("AI" + "za", "Sy0_x-", 35),
  slack: fake("xo" + "xb-", "1234-abcd", 24),
  synapse: fake("gp" + "app_", "k9Zr", 32),
  jwt: ["ey" + "J" + "hbGciOiJIUzI1NiJ9", "ey" + "J" + "zdWIiOiJ0ZXN0In0", "c2lnbmF0dXJlLXZhbHVl"].join("."),
}

describe("redactSecrets (#26)", () => {
  test("hides each high-confidence key shape and names its kind", () => {
    for (const [kind, key] of Object.entries(KEYS)) {
      const out = redactSecrets(`$ echo $KEY\n${key}\n`)
      expect(out).not.toContain(key)
      expect(out).toContain(`[REDACTED:${kind}]`)
    }
  })

  test("leaves ordinary output unchanged", () => {
    const text = [
      "src/index.ts:12  const sk = 'task-runner'",
      "commit 43274025e9b7828756953381e21052b2fc8082e4",
      "sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4",
      "uuid 3f2c9a7e-1d4b-4c8e-9a2f-6b7d8e9f0a1b, base64 aGVsbG8gd29ybGQ=",
      "AKIA is a prefix; sk-short is too short",
    ].join("\n")
    expect(redactSecrets(text)).toBe(text)
  })

  test("a private key block is hidden whole", () => {
    const block = ["-----BEGIN " + "RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA", "-----END " + "RSA PRIVATE KEY-----"].join("\n")
    expect(redactSecrets(`before\n${block}\nafter`)).toBe("before\n[REDACTED:private-key]\nafter")
  })
})

describe("redactToolResult (#26)", () => {
  test("redacts output, title and string metadata in place, and counts the changes", () => {
    const result = {
      title: `echo ${KEYS.openrouter}`,
      output: `key: ${KEYS.openrouter}`,
      metadata: { output: KEYS.github, exit: 0, nested: { lines: [KEYS.aws, "fine"] } },
    }
    expect(redactToolResult(result)).toBe(4)
    expect(JSON.stringify(result)).not.toMatch(/sk-or-v1-|ghp_|AKIA/)
    expect(result.metadata.exit).toBe(0)
    expect(result.metadata.nested.lines[1]).toBe("fine")
  })

  test("a missing result, a clean result and a frozen object are left alone", () => {
    expect(redactToolResult(undefined)).toBe(0)
    const clean = { title: "ls", output: "a.txt\nb.txt", metadata: {} }
    expect(redactToolResult(clean)).toBe(0)
    expect(clean.output).toBe("a.txt\nb.txt")
    const frozen = { title: "x", output: "ok", metadata: Object.freeze({ output: KEYS.github }) }
    expect(() => redactToolResult(frozen)).not.toThrow()
  })
})

describe("observer redactSensitiveData (#26)", () => {
  test("names the field it masked instead of writing a literal $1", () => {
    expect(redactSensitiveData("token=abcdefgh12345678")).toBe("token: [REDACTED]")
  })

  test("also hides high-confidence keys in diagnostics strings", () => {
    expect(redactSensitiveData(`ran: echo ${KEYS.openrouter}`)).toBe("ran: echo [REDACTED:openrouter]")
  })
})
