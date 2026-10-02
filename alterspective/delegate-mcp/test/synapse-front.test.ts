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
import { AUTH_CONF_SHAPE, MAX_TOKEN_LENGTH, authConf, authConfPath, ensureAuthConf, isAuthConf, writeAuthConf } from "../src/synapse/auth-conf.ts"
import { liveAuth } from "../src/synapse/index.ts"
import { SYNAPSE_ROUTES, expectedSynapseLocations, locationLines } from "../src/synapse/front-routes.ts"
import { synapseLine } from "../src/tools/doctor.ts"
import { SIGNED_IN, jwt } from "./synapse-fixture.ts"
import { generationExec } from "./front-generation-fixture.ts"

const TOKEN = jwt({ sub: "oid-1" })

describe("synapse-auth.conf", () => {
  test("holds exactly one `set` of the variable, empty or Bearer <JWT>", () => {
    expect(authConf(undefined)).toMatch(AUTH_CONF_SHAPE)
    expect(authConf(TOKEN)).toMatch(AUTH_CONF_SHAPE)
    expect(authConf(TOKEN).split("\n").filter((line) => line && !line.startsWith("#"))).toEqual([`set $synapse_auth "Bearer ${TOKEN}";`])
  })

  test("L3: a token longer than the cap is refused; one at the cap is accepted", () => {
    const at = jwt({ sub: "x", pad: "p".repeat(4000) })
    const capped = `${at.split(".")[0]}.${at.split(".")[1]!.slice(0, MAX_TOKEN_LENGTH - at.split(".")[0]!.length - 45)}.${"s".repeat(43)}`
    expect(capped.length).toBe(MAX_TOKEN_LENGTH)
    expect(isAuthConf(authConf(capped))).toBe(true)
    expect(() => authConf(`${capped}x`)).toThrow()
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

  test("H1: the synapse server refuses every path (no token) except the exact model routes", () => {
    const synapse = block("synapse2-api.alterspective.com.au")
    expect(locationLines(synapse)).toEqual(expectedSynapseLocations())
    expect(expectedSynapseLocations()).toEqual(["location / {", "location = /v1/chat/completions {", "location = /v1/models {"])
    const catchAll = synapse.slice(synapse.indexOf("location / {"), synapse.indexOf("}", synapse.indexOf("location / {")))
    expect(catchAll).toContain("return 403;")
    expect(catchAll).not.toContain("synapse_auth")
    expect(catchAll).not.toContain("proxy_pass")
  })

  test("each model route: its methods only, no query, fixed upstream path, box credentials dropped, owner's token set", () => {
    const synapse = block("synapse2-api.alterspective.com.au")
    for (const route of SYNAPSE_ROUTES) {
      const at = synapse.indexOf(`location = ${route.path} {`)
      const body = synapse.slice(at, synapse.indexOf("\n    }", at)).split("\n").map((line) => line.trim())
      expect(body).toContain(`limit_except ${route.methods.join(" ")} { deny all; }`)
      expect(body).toContain("if ($is_args) { return 403; }")
      expect(body).toContain(`proxy_pass https://$front_upstream${route.path};`)
      expect(body).toContain("proxy_set_header Authorization $synapse_auth;")
      expect(body).toContain('proxy_set_header x-api-key "";')
      // The variable starts empty BEFORE the include, so a missing token sends no credential at all.
      expect(body.indexOf('set $synapse_auth "";')).toBeLessThan(body.indexOf("include /etc/nginx/front-gen/synapse-auth.conf;"))
    }
    expect(SYNAPSE_ROUTES).toEqual([{ path: "/v1/chat/completions", methods: ["POST"] }, { path: "/v1/models", methods: ["GET"] }])
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

describe("doctor: front's loaded include and routes", () => {
  const servers = frontServersFor(defaultConfig({}))
  const good = authConf(TOKEN)

  test("shape, token presence, same file as this home, model routes only; never the value", async () => {
    const live = await liveAuth(generationExec(servers, good), "c-front", good)
    expect(live).toEqual({ shapeOk: true, hasToken: true, matchesHost: true, routesOk: true })
    expect(JSON.stringify(live)).not.toContain(TOKEN)
    expect(await liveAuth(generationExec(servers, authConf(undefined)), "c-front", authConf(undefined))).toMatchObject({ shapeOk: true, hasToken: false })
    expect(await liveAuth(generationExec(servers, `${good}return 200;\n`), "c-front", good)).toMatchObject({ shapeOk: false, hasToken: false, matchesHost: false })
    expect(await liveAuth(generationExec(servers, good, ""), "c-front", good)).toHaveProperty("unavailable")
  })

  test("L6: front loaded another home's include: not matching", async () => {
    expect(await liveAuth(generationExec(servers, authConf(jwt({ sub: "someone-else" }))), "c-front", good)).toMatchObject({ matchesHost: false })
  })

  test("H1: a loaded synapse server that forwards the whole host is caught", async () => {
    const old = servers.replace(/location = \/v1\/models \{/, "location /v1/ {")
    expect(await liveAuth(generationExec(old, good), "c-front", good)).toMatchObject({ routesOk: false })
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
