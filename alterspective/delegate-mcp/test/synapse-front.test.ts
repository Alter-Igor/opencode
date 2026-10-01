// WS2 (#48): the front include (shape, refusal of anything else), the generated synapse server
// (drops the box's credentials, sets the owner's), the doctor's live check, and that the box
// profile and env carry no Synapse key.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { frontServersFor } from "../src/guard/egress.ts"
import { DEFAULT_PROJECT, defaultConfig, projectName } from "../src/shared/config.ts"
import { DelegateError } from "../src/shared/errors.ts"
import { boxEnvOverride, composeEnv } from "../src/supervisor/compose-env.ts"
import { FRONT_AUTH_PLACEHOLDER, buildProfile } from "../src/supervisor/profile.ts"
import { AUTH_CONF_SHAPE, authConf, authConfPath, ensureAuthConf, isAuthConf, writeAuthConf } from "../src/synapse/auth-conf.ts"
import { liveAuth } from "../src/synapse/index.ts"
import { synapseLine } from "../src/tools/doctor.ts"
import { SIGNED_IN, jwt } from "./synapse-fixture.ts"

const TOKEN = jwt({ sub: "oid-1" })

describe("synapse-auth.conf", () => {
  test("holds exactly one `set` of the variable, empty or Bearer <JWT>", () => {
    expect(authConf(undefined)).toMatch(AUTH_CONF_SHAPE)
    expect(authConf(TOKEN)).toMatch(AUTH_CONF_SHAPE)
    expect(authConf(TOKEN).split("\n").filter((line) => line && !line.startsWith("#"))).toEqual([`set $synapse_auth "Bearer ${TOKEN}";`])
  })

  test("refuses any value that could change other nginx config", () => {
    for (const bad of ['a"; return 200; #', `${TOKEN}\nproxy_pass http://x;`, "a.b.c", `${TOKEN};`, "$host.x.y"]) expect(() => authConf(bad)).toThrow()
    expect(isAuthConf(`${authConf(TOKEN)}proxy_set_header X-Evil 1;\n`)).toBe(false)
    expect(isAuthConf(authConf(TOKEN).replace("$synapse_auth", "$front_upstream"))).toBe(false)
  })

  test("written then renamed; ensureAuthConf repairs a missing or malformed file to the empty one", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocd-front-"))
    await ensureAuthConf(dir)
    expect(readFileSync(authConfPath(dir), "utf8")).toBe(authConf(undefined))
    await writeAuthConf(dir, TOKEN)
    await ensureAuthConf(dir)
    expect(readFileSync(authConfPath(dir), "utf8")).toBe(authConf(TOKEN))
    writeFileSync(authConfPath(dir), "proxy_pass http://evil;\n")
    await ensureAuthConf(dir)
    expect(readFileSync(authConfPath(dir), "utf8")).toBe(authConf(undefined))
  })
})

describe("generated front servers", () => {
  const servers = frontServersFor(defaultConfig({}))
  const block = (host: string) => servers.slice(servers.indexOf(`server_name ${host};`), servers.indexOf("}\n}", servers.indexOf(`server_name ${host};`)))

  test("the synapse server drops the box's Authorization and x-api-key and sets the owner's token", () => {
    const synapse = block("synapse2-api.alterspective.com.au")
    const lines = synapse.split("\n").map((line) => line.trim())
    expect(lines).toContain('set $synapse_auth "";')
    expect(lines).toContain("include /etc/nginx/front-gen/synapse-auth.conf;")
    expect(lines).toContain("proxy_set_header Authorization $synapse_auth;")
    expect(lines).toContain('proxy_set_header x-api-key "";')
    // The variable starts empty BEFORE the include, so a missing token sends no credential at all.
    expect(lines.indexOf('set $synapse_auth "";')).toBeLessThan(lines.indexOf("include /etc/nginx/front-gen/synapse-auth.conf;"))
  })

  test("the Keystone server does not get the Synapse token", () => {
    expect(block("identity.alterspective.com.au")).not.toContain("synapse_auth")
  })

  test("nginx logs never carry the Authorization header", () => {
    const nginx = readFileSync(path.join(import.meta.dir, "..", "docker", "front", "nginx.conf"), "utf8")
    const format = nginx.split("\n").find((line) => line.includes("log_format")) ?? ""
    expect(format).not.toMatch(/http_authorization|http_x_api_key|\$http_|\$request\b|request_uri|\$args/)
  })
})

describe("doctor: front's loaded include", () => {
  const dump = (section: string) => `# configuration file /etc/nginx/nginx.conf:\nhttp {}\n\n# configuration file /etc/nginx/front-gen/synapse-auth.conf:\n${section}\n# configuration file /etc/nginx/front/upstream.conf:\nproxy_ssl_server_name on;\n\n`
  const execWith = (stdout: string, code = 0) => async () => ({ code, stdout, stderr: "" })

  test("shape and token presence are reported; the value is not", async () => {
    const live = await liveAuth(execWith(dump(authConf(TOKEN))), "c-front")
    expect(live).toEqual({ shapeOk: true, hasToken: true })
    expect(JSON.stringify(live)).not.toContain(TOKEN)
    expect(await liveAuth(execWith(dump(authConf(undefined))), "c-front")).toEqual({ shapeOk: true, hasToken: false })
    expect(await liveAuth(execWith(dump(`${authConf(TOKEN)}return 200;\n`)), "c-front")).toEqual({ shapeOk: false, hasToken: false })
    expect(await liveAuth(execWith("", 1), "c-front")).toHaveProperty("unavailable")
  })

  test("the doctor line names states, never values", () => {
    expect(synapseLine(SIGNED_IN)).toContain("signed in as owner@example.test via service:opencode")
    expect(synapseLine({ ...SIGNED_IN, state: "needs_sign_in", ok: false })).toContain('NEEDS SIGN-IN (no model calls until then; run oc_login {server: "synapse"})')
  })
})

describe("the box holds no Synapse credential", () => {
  const owner = JSON.stringify({
    model: "synapse/auto",
    provider: {
      synapse: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://synapse2-api.alterspective.com.au/v1", apiKey: "{env:SYNAPSE_API_KEY}", headers: { "X-Api-Key": "{env:SYNAPSE_API_KEY}", Authorization: "Bearer {env:SYNAPSE_API_KEY}" } },
        models: { auto: { name: "auto" } },
      },
    },
  })

  test("default config approves no box env, so the compose override names none", () => {
    expect(defaultConfig({}).boxEnv).toEqual([])
    expect(boxEnvOverride(defaultConfig({}).boxEnv)).toBe("services: {}\n")
  })

  test("the profile keeps the synapse provider with a placeholder key and no credential header", () => {
    const built = buildProfile({ ownerConfigs: [owner], config: { ...defaultConfig({}), keystoneConnections: [] }, permission: [], frontAuth: ["synapse"] })
    const text = built.files["opencode/opencode.json"] ?? ""
    expect(built.providers).toContain("synapse")
    expect(text).not.toContain("SYNAPSE_API_KEY")
    const options = (JSON.parse(text) as { provider: { synapse: { options: Record<string, unknown> } } }).provider.synapse.options
    expect(options).toEqual({ baseURL: "https://synapse2-api.alterspective.com.au/v1", apiKey: FRONT_AUTH_PLACEHOLDER, headers: {} })
  })

  test("the compose child never gets a Synapse key, even when the host has one", () => {
    const config = defaultConfig({ OPENCODE_DELEGATE_HOME: os.tmpdir() })
    const built = { files: {}, hash: "h", providers: [], dropped: [] }
    const env = composeEnv({ config, hostEnv: { PATH: "p", SYNAPSE_API_KEY: "host-key" }, image: "img", opencodeVersion: "1" }, { built, port: 1, password: "pw", front: { servers: "", hash: "f" } })
    expect(Object.keys(env).filter((name) => /SYNAPSE/i.test(name))).toEqual([])
    expect(Object.values(env)).not.toContain("host-key")
  })
})

describe("OPENCODE_DELEGATE_PROJECT", () => {
  test("default, valid and invalid names", () => {
    expect(projectName(undefined)).toBe(DEFAULT_PROJECT)
    expect(defaultConfig({ OPENCODE_DELEGATE_PROJECT: "ocd-ws2" }).project).toBe("ocd-ws2")
    for (const bad of ["OCD", "-x", "a_b", "a b", "x".repeat(41)]) expect(() => projectName(bad)).toThrow(DelegateError)
  })
})
