import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect"
import { ServerAuth } from "../src/auth"

const password = "test-only:password-\u03b1"
const digest = createHash("sha256").update(password).digest("hex")
const saved = { ...process.env }
const config = { username: "opencode", password: Option.none<string>(), passwordSHA256: digest }
const credential = (password: string, username = "opencode") => ({ username, password: Redacted.make(password) })
const load = (env: Record<string, string>) =>
  Effect.runPromise(
    ServerAuth.Config.pipe(
      Effect.provide(
        ServerAuth.Config.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))),
      ),
    ),
  )

afterEach(() => {
  for (const key of ["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_PASSWORD_SHA256", "OPENCODE_SERVER_USERNAME"]) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe("verifier-only server authentication", () => {
  test("requires auth and accepts only the password preimage with the right user", () => {
    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized(credential(password), config)).toBe(true)
    for (const candidate of [digest, "", "wrong", password.normalize("NFD") + "x"])
      expect(ServerAuth.authorized(credential(candidate), config)).toBe(false)
    expect(ServerAuth.authorized(credential(password, "other"), config)).toBe(false)
  })

  test("reads the verifier through Effect configuration", async () => {
    const actual = await load({ OPENCODE_SERVER_PASSWORD_SHA256: digest })
    expect(ServerAuth.required(actual)).toBe(true)
    expect(ServerAuth.authorized(credential(password), actual)).toBe(true)
  })

  test("rejects present malformed verifiers and mixed password modes at startup", async () => {
    for (const value of ["", "0".repeat(63), "g".repeat(64), digest.toUpperCase(), ` ${digest}`])
      await expect(load({ OPENCODE_SERVER_PASSWORD_SHA256: value })).rejects.toThrow()
    for (const value of ["", password])
      await expect(load({ OPENCODE_SERVER_PASSWORD_SHA256: digest, OPENCODE_SERVER_PASSWORD: value })).rejects.toThrow()
  })

  test("trusted headers use a stable process credential without publishing it in env", () => {
    delete process.env.OPENCODE_SERVER_PASSWORD
    process.env.OPENCODE_SERVER_PASSWORD_SHA256 = digest
    const before = JSON.stringify(process.env)
    const header = ServerAuth.header()
    expect(typeof header).toBe("string")
    expect(ServerAuth.header()).toBe(header)
    expect(JSON.stringify(process.env) === before).toBe(true)
    const decoded = Buffer.from(header!.slice(6), "base64").toString()
    const candidate = decoded.slice(decoded.indexOf(":") + 1)
    expect(candidate).not.toBe(password)
    expect(candidate).not.toBe(digest)
    expect(ServerAuth.authorized(credential(candidate), config)).toBe(true)
    expect(
      ServerAuth.authorized(credential(candidate), { username: "opencode", password: Option.some(password) }),
    ).toBe(false)
    expect(ServerAuth.header({ password })).toBe(`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`)
  })

  test("unset verifier keeps the upstream plaintext and no-auth behavior", async () => {
    expect(ServerAuth.required(await load({}))).toBe(false)
    const actual = await load({ OPENCODE_SERVER_PASSWORD: password })
    expect(ServerAuth.authorized(credential(password), actual)).toBe(true)
    expect(ServerAuth.authorized(credential(digest), actual)).toBe(false)
  })
})
