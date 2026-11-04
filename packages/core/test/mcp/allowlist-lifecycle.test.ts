import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Scope } from "effect"
import { Credential } from "../../src/credential"
import { McpAllow } from "../../src/mcp/allowlist"
import { McpConnection } from "../../src/mcp/connection"
import { McpOAuth } from "../../src/mcp/oauth"
import { tmpdir } from "../fixture/tmpdir"

function withPolicy<T>(origin: string, fn: () => Promise<T>): Promise<T> {
  const policy = JSON.stringify({ remote: [{ origin, path: "^/mcp/(dynamic|c/[A-Za-z0-9_-]+)$" }] })
  const previous = process.env[McpAllow.ENV]
  process.env[McpAllow.ENV] = policy
  return fn().finally(() => {
    if (previous === undefined) delete process.env[McpAllow.ENV]
    else process.env[McpAllow.ENV] = previous
  })
}

describe("MCP allowlist lifecycle (#41, #67)", () => {
  test("a refused remote entry never opens a connection", async () => {
    const requests: string[] = []
    const http = Bun.serve({
      port: 0,
      fetch(req) {
        requests.push(`${req.method} ${new URL(req.url).pathname}`)
        return new Response("unexpected", { status: 500 })
      },
    })
    const url = new URL("/mcp/dynamic", http.url).toString()
    const origin = new URL(http.url).origin

    try {
      await withPolicy("https://identity.alterspective.com.au", async () => {
        let failedStatus: McpConnection.Failure | undefined
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const scope = yield* Scope.Scope
              const conn = McpConnection.make({
                name: "ks-refused",
                config: { type: "remote", url },
                directory: process.cwd(),
                authProvider: Effect.succeed(undefined),
                elicitation: {
                  create: () => Effect.die("unused"),
                  complete: () => Effect.void,
                },
                environment: {} as never,
                scope,
                lock: (fx) => fx,
                handshake: (fx) => fx,
                callbacks: () => {},
                fork: () => {},
                events: {
                  connecting: Effect.void,
                  connected: Effect.void,
                  failed: (f) =>
                    Effect.sync(() => {
                      failedStatus = f
                    }),
                  settled: Effect.void,
                  stopped: Effect.void,
                  closed: () => Effect.void,
                  toolsChanged: Effect.void,
                  promptsChanged: Effect.void,
                  resourcesChanged: Effect.void,
                },
              })
              yield* conn.start
            }),
          ),
        )

        expect(failedStatus).toEqual({
          status: "failed",
          error: `blocked by OPENCODE_MCP_ALLOW: ${origin}/mcp/dynamic is not an allowed MCP URL`,
        })
        expect(requests).toEqual([])
      })
    } finally {
      http.stop(true)
    }
  })

  test("a refused local entry never spawns its process", async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "spawned.txt")

    await withPolicy("https://identity.alterspective.com.au", async () => {
      let failedStatus: McpConnection.Failure | undefined
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Scope.Scope
            const conn = McpConnection.make({
              name: "ks-local",
              config: {
                type: "local",
                command: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
              },
              directory: tmp.path,
              authProvider: Effect.succeed(undefined),
              elicitation: {
                create: () => Effect.die("unused"),
                complete: () => Effect.void,
              },
              environment: {} as never,
              scope,
              lock: (fx) => fx,
              handshake: (fx) => fx,
              callbacks: () => {},
              fork: () => {},
              events: {
                connecting: Effect.void,
                connected: Effect.void,
                failed: (f) =>
                  Effect.sync(() => {
                    failedStatus = f
                  }),
                settled: Effect.void,
                stopped: Effect.void,
                closed: () => Effect.void,
                toolsChanged: Effect.void,
                promptsChanged: Effect.void,
                resourcesChanged: Effect.void,
              },
            })
            yield* conn.start
          }),
        ),
      )

      expect(failedStatus).toEqual({
        status: "failed",
        error: 'blocked by OPENCODE_MCP_ALLOW: "ks-local" is not a remote MCP server',
      })
      expect(fs.existsSync(marker)).toBe(false)
    })
  })

  test("McpOAuth.authorize refuses a blocked entry before any request", async () => {
    const requests: string[] = []
    const http = Bun.serve({
      port: 0,
      fetch(req) {
        requests.push(`${req.method} ${new URL(req.url).pathname}`)
        return new Response("unexpected", { status: 500 })
      },
    })
    const url = new URL("/mcp/dynamic", http.url).toString()

    try {
      await withPolicy("https://identity.alterspective.com.au", async () => {
        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            McpOAuth.authorize({
              name: "ks-auth",
              config: { type: "remote", url },
              integrationID: "mcp:ks-auth" as never,
              methodID: "oauth" as never,
            }).pipe(Effect.provide(Layer.mock(Credential.Service, {}))),
          ),
        )
        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain("blocked by OPENCODE_MCP_ALLOW")
        expect(requests).toEqual([])
      })
    } finally {
      http.stop(true)
    }
  })
})
