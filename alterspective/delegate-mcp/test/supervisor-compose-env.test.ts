// FEAT-OCD-001 W2C-14: the box env override may not name a variable the sandbox sets itself.
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { DelegateError } from "../src/shared/errors.ts"
import { boxEnvOverride, isReservedBoxEnv } from "../src/supervisor/compose-env.ts"

describe("box env override: reserved names", () => {
  test("override refuses names the sandbox sets itself or that are bridge-only secrets (W2C-14)", () => {
    const reserved = [
      "INBOX_ADMIN_TOKEN", "OPENCODE_SERVER_PASSWORD", "OPENCODE_MCP_ALLOW", "OPENCODE_DISABLE_PROJECT_CONFIG", "OCD_INBOX_URL", "OCD_ANYTHING",
      "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "HOME", "PATH", "XDG_CONFIG_HOME", "npm_config_registry", "PIP_INDEX_URL",
    ]
    for (const name of reserved) {
      const error = (() => {
        try {
          boxEnvOverride(["SYNAPSE_API_KEY", name])
        } catch (caught) {
          return caught as DelegateError
        }
        throw new Error(`${name} was accepted`)
      })()
      expect(error.code).toBe("invalid_input")
      expect(error.detail).toBe(`name=${name}`)
    }
    expect(boxEnvOverride(["SYNAPSE_API_KEY", "ANTHROPIC_API_KEY", "PROXY_TIMEOUT"])).toContain("ANTHROPIC_API_KEY:")
  })

  test("every variable compose.yaml sets for the box is reserved, so the override cannot replace it", async () => {
    const yaml = (await readFile(path.join(import.meta.dir, "..", "docker", "compose.yaml"), "utf8")).replace(/\r\n/g, "\n")
    const box = yaml.slice(yaml.indexOf("\n  box:"), yaml.indexOf("\n  gate:"))
    const env = box.slice(box.indexOf("\n    environment:"), box.indexOf("\n    healthcheck:"))
    const names = [...env.matchAll(/^ {6}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]!)
    expect(names.length).toBeGreaterThan(20)
    expect(names.filter((name) => !isReservedBoxEnv(name))).toEqual([])
  })
})
