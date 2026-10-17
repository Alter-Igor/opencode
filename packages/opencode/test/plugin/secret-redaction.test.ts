// #26: credentials in tool results are hidden before the session store keeps them.
// Fixtures are assembled at run time so this file never holds a string that looks like a real
// key to a secret scanner (GitHub push protection, gitleaks).
import { describe, expect, test } from "bun:test"
import { redactedCopy, redactSecrets, redactToolPart, redactToolResult } from "../../src/plugin/secret-redaction"
import { redactSensitiveData } from "../../src/plugin/observer"
import { SynapseAuthPlugin } from "../../src/plugin/synapse"

const fake = (prefix: string, body: string, length: number) => prefix + body.repeat(Math.ceil(length / body.length)).slice(0, length)

const KEYS: Record<string, string> = {
  openrouter: fake("sk-" + "or-v1-", "5a5f0c", 64),
  anthropic: fake("sk-" + "ant-api03-", "Ab9_", 90),
  openai: fake("sk-" + "proj-", "Q7xZ", 48),
  stripe: fake("sk" + "_live_", "aB3", 24),
  github: fake("gh" + "p_", "aB3dE", 36),
  gitlab: fake("gl" + "pat-", "aB3_x", 20),
  npm: fake("np" + "m_", "aB3dE", 36),
  huggingface: fake("h" + "f_", "aB3", 34),
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

  test("a key glued to an underscore still counts (QA on #26)", () => {
    expect(redactSecrets(`X_${KEYS.openrouter}`)).toBe("X_[REDACTED:openrouter]")
  })

  test("named secrets keep their name and lose the value", () => {
    const slackApp = fake("xa" + "pp-1-", "A1b2C3", 16)
    const cases: Array<[string, string]> = [
      [`aws_secret_access_key = ${fake("", "aB3/+", 40)}`, "aws_secret_access_key = [REDACTED:aws]"],
      [`DefaultEndpointsProtocol=https;AccountKey=${fake("", "aB3+/", 44)};`, "DefaultEndpointsProtocol=https;AccountKey=[REDACTED:azure];"],
      [`Authorization: Bearer ${fake("", "aB3._~", 32)}`, "Authorization: Bearer [REDACTED:bearer]"],
      [`git clone https://deploy:${"s3cr3t" + "Passw0rd"}@git.example.com/x`, "git clone https://deploy:[REDACTED:url-credentials]@git.example.com/x"],
      // CodeRabbit and QA on #26: a raw "@", "#" or "?" in the password; the query after the path is left alone.
      [`https://u:${"p@ss" + "w0rd"}@db.example.com/x?next=a@b`, "https://u:[REDACTED:url-credentials]@db.example.com/x?next=a@b"],
      [`postgres://app:${"Xk9#" + "mP2q"}@db:5432/x`, "postgres://app:[REDACTED:url-credentials]@db:5432/x"],
      [`DATABASE_URL=mysql://root:${"Tr0ub4dor" + "?3"}@localhost/app`, "DATABASE_URL=mysql://root:[REDACTED:url-credentials]@localhost/app"],
      [`"https://u:${"pw" + "99"}@h","b":"c@d"`, `"https://u:[REDACTED:url-credentials]@h","b":"c@d"`],
      [slackApp, "[REDACTED:slack]"],
    ]
    for (const [input, expected] of cases) expect(redactSecrets(input)).toBe(expected)
  })

  test("leaves ordinary output unchanged, including sk- names that are not keys (QA on #26)", () => {
    const text = [
      "src/index.ts:12  const sk = 'task-runner'",
      "commit 43274025e9b7828756953381e21052b2fc8082e4",
      "sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4",
      "uuid 3f2c9a7e-1d4b-4c8e-9a2f-6b7d8e9f0a1b, base64 aGVsbG8gd29ybGQ=",
      "AKIA is a prefix; sk-short is too short",
      "sk-project-management-dashboard-component-v2",
      "node_modules/sk-learn-wrapper-for-python-bindings/index.js",
      "origin/sk-add-the-retry-when-windows-refuses-rename",
      "git@github.com:Alter-Igor/opencode.git",
    ].join("\n")
    expect(redactSecrets(text)).toBe(text)
  })

  test("a private key block is hidden whole; one cut off before END is hidden to the end", () => {
    const begin = "-----BEGIN " + "RSA PRIVATE KEY-----"
    const end = "-----END " + "RSA PRIVATE KEY-----"
    expect(redactSecrets(`before\n${begin}\nMIIEowIBAAKCAQEA\n${end}\nafter`)).toBe("before\n[REDACTED:private-key]\nafter")
    expect(redactSecrets(`before\n${begin}\nMIIEowIBAAKC (truncated)`)).toBe("before\n[REDACTED:private-key]")
  })

  test("large output with many unterminated BEGIN lines stays fast (QA on #26: linear scan)", () => {
    const line = "-----BEGIN " + "EC PRIVATE KEY-----\n" + "x".repeat(1000) + "\n"
    const text = "start\n" + line.repeat(5000)
    const began = performance.now()
    const out = redactSecrets(text)
    expect(performance.now() - began).toBeLessThan(1000)
    expect(out).toBe("start\n[REDACTED:private-key]")
  })

  test("long runs of scheme characters stay fast (architect on #26: url-credentials was quadratic)", () => {
    for (const text of ["a.".repeat(50_000), "a-b-".repeat(25_000), "1.2.".repeat(25_000)]) {
      const began = performance.now()
      expect(redactSecrets(text)).toBe(text)
      expect(performance.now() - began).toBeLessThan(1000)
    }
    expect(redactSecrets(`x git+ssh://u:${"pw" + "1234"}@h/r`)).toBe("x git+ssh://u:[REDACTED:url-credentials]@h/r")
  })

  test("a streamed shell chunk is cheap to scan (QA on #26: a leading look-behind cost ~7 ms per 30 KB)", () => {
    const chunk = "src/session/processor.ts:352 ok sk-short ghp-not a.b.c-d https://example.com/x\n".repeat(400)
    redactSecrets(chunk)
    const began = performance.now()
    for (let i = 0; i < 50; i++) expect(redactSecrets(chunk)).toBe(chunk)
    expect(performance.now() - began).toBeLessThan(250)
  })
})

describe("redactSecrets pattern follow-ups (#207)", () => {
  test("finds the shapes the #26 QA rounds missed", () => {
    const cases: Array<[string, string]> = [
      [`redis://:${"pw" + "Secret9"}@cache:6379`, "redis://:[REDACTED:url-credentials]@cache:6379"],
      [`authorization: bearer ${fake("", "aB3._~", 32)}`, "authorization: bearer [REDACTED:bearer]"],
      [`AUTHORIZATION: BEARER ${fake("", "Zq8x", 28)}`, "AUTHORIZATION: BEARER [REDACTED:bearer]"],
      [`{"SecretAccessKey": "${fake("", "aB3/+", 40)}"}`, '{"SecretAccessKey": "[REDACTED:aws]"}'],
      [`AWS_SECRET_ACCESS_KEY=${fake("", "Qw9+", 40)}`, "AWS_SECRET_ACCESS_KEY=[REDACTED:aws]"],
      [`${"sk-"}${fake("", "q7x2zr", 48)}`, "[REDACTED:openai]"],
    ]
    for (const [input, output] of cases) expect(redactSecrets(input)).toBe(output)
  })

  test("hides a PGP private key block, with or without its END line", () => {
    const begin = "-----BEGIN " + "PGP PRIVATE KEY BLOCK-----"
    const end = "-----END " + "PGP PRIVATE KEY BLOCK-----"
    expect(redactSecrets(`a\n${begin}\nlQOYBF\n${end}\nb`)).toBe("a\n[REDACTED:private-key]\nb")
    expect(redactSecrets(`a\n${begin}\nlQOYBF cut off`)).toBe("a\n[REDACTED:private-key]")
  })

  test("leaves the #26 false positives alone", () => {
    const text = [
      "Authorization: Bearer YOUR_API_TOKEN_GOES_HERE",
      "Bearer src/plugin/observer/module.ts",
      "Bearer ./scripts/release/publish-all.sh",
      "http://x:12:34@y",
      "sk-ReactComponentLibraryVersion2BuildOutput",
      "a bearer of bad news",
    ].join("\n")
    expect(redactSecrets(text)).toBe(text)
  })

  test("still hides a digits-only URL password and a bearer token that holds a slash", () => {
    expect(redactSecrets(`http://admin:${"123" + "456"}@host/x`)).toBe("http://admin:[REDACTED:url-credentials]@host/x")
    expect(redactSecrets(`Bearer ${fake("", "aB3/", 32)}`)).toBe("Bearer [REDACTED:bearer]")
  })
})

describe("redactedCopy (#26, QA: doom-loop guard)", () => {
  test("returns a redacted deep copy and leaves the value alone", () => {
    const input = { command: `curl -H "x-api-key: ${KEYS.synapse}"`, n: 1 }
    const copy = redactedCopy(input)
    expect(copy).toEqual({ command: 'curl -H "x-api-key: [REDACTED:synapse]"', n: 1 })
    expect(input.command).toContain(KEYS.synapse)
    expect(JSON.stringify(redactedCopy(input))).toBe(JSON.stringify(copy))
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

  test("an MCP result: text and embedded resource text are redacted, image data is untouched", () => {
    const data = "iVBORw0KGgo" + KEYS.aws // base64-looking image data, even if it happens to contain a key shape
    const result = {
      content: [
        { type: "text", text: `token ${KEYS.github}` },
        { type: "resource", resource: { uri: "file:///x", text: KEYS.synapse } },
        { type: "image", mimeType: "image/png", data },
      ],
    }
    expect(redactToolResult(result)).toBe(2)
    expect(result.content[0]).toEqual({ type: "text", text: "token [REDACTED:github]" })
    expect((result.content[1] as { resource: { text: string } }).resource.text).toBe("[REDACTED:synapse]")
    expect((result.content[2] as { data: string }).data).toBe(data)
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

describe("redactToolPart: every stored copy of a tool part (#26, QA)", () => {
  test("a running part: streamed shell output in metadata is redacted", () => {
    const part = { type: "tool", state: { status: "running", input: { command: "echo $KEY" }, metadata: { output: `${KEYS.openrouter}\n` } } }
    expect(redactToolPart(part)).toBe(1)
    expect(part.state.metadata.output).toBe("[REDACTED:openrouter]\n")
  })

  test("a failed part: error text and input arguments are redacted", () => {
    const part = { type: "tool", state: { status: "error", input: { command: `curl -H "x-api-key: ${KEYS.synapse}"` }, error: `401 for ${KEYS.synapse}` } }
    expect(redactToolPart(part)).toBe(2)
    expect(JSON.stringify(part)).not.toContain(KEYS.synapse)
  })

  test("attachments and other part types are left alone", () => {
    const attachment = { type: "file", url: "data:image/png;base64,iVBORw0KGgo" + KEYS.aws }
    const tool = { type: "tool", state: { status: "completed", output: "ok", attachments: [attachment] } }
    expect(redactToolPart(tool)).toBe(0)
    expect(tool.state.attachments[0]).toBe(attachment)
    const text = { type: "text", text: KEYS.github }
    expect(redactToolPart(text)).toBe(0)
    expect(text.text).toBe(KEYS.github)
  })
})

describe("wiring (#26, QA)", () => {
  test("the Synapse plugin's tool.execute.after hook redacts the result it is given", async () => {
    const hooks = await SynapseAuthPlugin({
      client: {} as never,
      project: {} as never,
      directory: "/test/dir",
      worktree: "",
      experimental_workspace: { register() {} },
      serverUrl: new URL("https://example.com"),
      $: {} as never,
    } as never)
    const output = { title: "bash", output: `KEY=${KEYS.openrouter}`, metadata: { output: KEYS.openrouter } }
    await hooks["tool.execute.after"]?.({ tool: "bash", sessionID: "ses_test", callID: "call_1", args: {} }, output)
    expect(output.output).toBe("KEY=[REDACTED:openrouter]")
    expect(output.metadata.output).toBe("[REDACTED:openrouter]")
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

describe("opencode import (#207)", () => {
  test("import.ts redacts each tool part before it inserts it (a direct PartTable insert skips Session.updatePart)", async () => {
    const source = await Bun.file(new URL("../../src/cli/cmd/import.ts", import.meta.url)).text()
    const redact = source.indexOf("redactToolPart(partInfo)")
    expect(redact).toBeGreaterThan(-1)
    expect(redact).toBeLessThan(source.indexOf(".insert(PartTable)"))
  })

  test("a decoded imported tool part is redacted in place", () => {
    const part = { type: "tool", state: { status: "completed", input: { command: "env" }, output: `KEY=${KEYS.openrouter}` } }
    expect(redactToolPart(part)).toBe(1)
    expect(part.state.output).toBe("KEY=[REDACTED:openrouter]")
  })
})
