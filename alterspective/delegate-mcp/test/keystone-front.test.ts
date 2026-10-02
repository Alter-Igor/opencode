// #67 step 3 (WS-A2): front injects each chosen Keystone connection's token from its own strict
// include, behind OCD_KEYSTONE_HOST_AUTH (off by default). Covered here:
// - the per-connection include (ks-auth-<id>.conf): same strict two-line shape as synapse-auth.conf,
//   variable $ks_auth, id validated like CONNECTION_ID;
// - the generated identity server: byte-identical with the flag off; with it on, each /mcp/c/<id>
//   includes ONLY its own file, and the box-facing OAuth paths are gone (403 from `location /`).
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { FRONT_GENERATED_MOUNT, frontConfigHash, frontServers, frontServersFor } from "../src/guard/egress.ts"
import { FRONT_INCLUDE_DIR, KEYSTONE_HOST_AUTH_ENV, KEYSTONE_OAUTH_PATHS, identityLocations, identityPaths, keystoneHostAuth } from "../src/guard/egress-identity.ts"
import { defaultConfig } from "../src/shared/config.ts"
import {
  AUTH_CONF_SHAPE,
  AUTH_VAR,
  KS_AUTH_CONF_SHAPE,
  KS_AUTH_VAR,
  authConf,
  authConfHasToken,
  ensureKsAuthConf,
  isAuthConf,
  ksAuthConfPath,
  ksAuthFileName,
  writeKsAuthConf,
} from "../src/synapse/auth-conf.ts"
import { jwt } from "./synapse-fixture.ts"

const TOKEN = jwt({ sub: "oid-1", aud: "https://identity.alterspective.com.au/mcp/c/rag-read" })
const HOSTS = ["identity.alterspective.com.au", "synapse2-api.alterspective.com.au"]
const IDENTITY = "identity.alterspective.com.au"
const CHOSEN = ["rag-read", "github", "seqlogs"]
/** sha256 of the generated servers.conf before #67 step 3 (dev 4f38093888): the flag-off output must not move. */
const BEFORE = {
  defaultConfig: "5811bbed5d3b1d9faddb27816bbf29e3e1acf9f7903b0d47b97a0450a2bdb9de",
  chosen: "5811bbed5d3b1d9faddb27816bbf29e3e1acf9f7903b0d47b97a0450a2bdb9de",
  none: "f060bc26e6c9b795da6b98933b69959155437a76db0d4d11a938b1389167dce7",
}

const saved = process.env[KEYSTONE_HOST_AUTH_ENV]
afterEach(() => {
  if (saved === undefined) delete process.env[KEYSTONE_HOST_AUTH_ENV]
  else process.env[KEYSTONE_HOST_AUTH_ENV] = saved
})

describe("ks-auth-<id>.conf (the per-connection include)", () => {
  test("the same strict two lines as synapse-auth.conf, with $ks_auth; synapse stays the default", () => {
    expect(AUTH_VAR).toBe("$synapse_auth")
    expect(KS_AUTH_VAR).toBe("$ks_auth")
    expect(authConf(TOKEN)).toMatch(AUTH_CONF_SHAPE)
    for (const token of [undefined, TOKEN]) {
      const text = authConf(token, KS_AUTH_VAR)
      expect(text).toMatch(KS_AUTH_CONF_SHAPE)
      expect(text.split("\n")[0]).toBe(authConf(token).split("\n")[0]!)
      expect(isAuthConf(text, KS_AUTH_VAR)).toBe(true)
      // Never accepted as the other variable's file, and the other way round.
      expect(isAuthConf(text)).toBe(false)
      expect(isAuthConf(authConf(token), KS_AUTH_VAR)).toBe(false)
    }
    expect(authConf(TOKEN, KS_AUTH_VAR).split("\n").filter((line) => line && !line.startsWith("#"))).toEqual([`set $ks_auth "Bearer ${TOKEN}";`])
    expect(authConfHasToken(authConf(TOKEN, KS_AUTH_VAR), KS_AUTH_VAR)).toBe(true)
    expect(authConfHasToken(authConf(undefined, KS_AUTH_VAR), KS_AUTH_VAR)).toBe(false)
  })

  test("refuses a value or a file that could change other nginx config", () => {
    for (const bad of ['a"; return 200; #', `${TOKEN}\nproxy_pass http://x;`, "a.b.c", `${TOKEN};`, "$host.x.y"]) expect(() => authConf(bad, KS_AUTH_VAR)).toThrow()
    const good = authConf(TOKEN, KS_AUTH_VAR)
    const [header] = good.split("\n")
    for (const bad of [
      `${good}proxy_pass https://evil;\n`,
      `${header}\nset $ks_auth "Bearer ${TOKEN}"; proxy_pass https://evil;\n`,
      `${header}\nset $synapse_auth "Bearer ${TOKEN}";\n`,
      `${header}\nset $front_upstream "evil";\n`,
      good.replaceAll("\n", "\r\n"),
      good.slice(0, -1),
    ])
      expect(isAuthConf(bad, KS_AUTH_VAR)).toBe(false)
  })

  test("file name per connection id, validated like CONNECTION_ID", () => {
    expect(ksAuthFileName("rag-read")).toBe("ks-auth-rag-read.conf")
    expect(ksAuthConfPath("front", "github")).toBe(path.join("front", "ks-auth-github.conf"))
    for (const bad of ["", "-x", "Rag", "a/b", "../x", "a.conf", "a b", "x".repeat(64), "a\nb"]) expect(() => ksAuthFileName(bad)).toThrow()
  })

  test("written then renamed; ensureKsAuthConf creates missing files empty and repairs malformed ones only", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocd-ks-front-"))
    await writeKsAuthConf(dir, "rag-read", TOKEN)
    expect(readFileSync(ksAuthConfPath(dir, "rag-read"), "utf8")).toBe(authConf(TOKEN, KS_AUTH_VAR))
    writeFileSync(ksAuthConfPath(dir, "github"), "proxy_pass http://evil;\n")
    await ensureKsAuthConf(dir, ["rag-read", "github", "seqlogs"])
    expect(readFileSync(ksAuthConfPath(dir, "rag-read"), "utf8")).toBe(authConf(TOKEN, KS_AUTH_VAR))
    expect(readFileSync(ksAuthConfPath(dir, "github"), "utf8")).toBe(authConf(undefined, KS_AUTH_VAR))
    expect(readFileSync(ksAuthConfPath(dir, "seqlogs"), "utf8")).toBe(authConf(undefined, KS_AUTH_VAR))
    await writeKsAuthConf(dir, "rag-read", undefined)
    expect(readFileSync(ksAuthConfPath(dir, "rag-read"), "utf8")).toBe(authConf(undefined, KS_AUTH_VAR))
    await expect(writeKsAuthConf(dir, "../evil", TOKEN)).rejects.toThrow()
    await expect(writeKsAuthConf(dir, "rag-read", "not-a-jwt")).rejects.toThrow()
  })
})

describe("OCD_KEYSTONE_HOST_AUTH", () => {
  test("off unless exactly 1", () => {
    expect(KEYSTONE_HOST_AUTH_ENV).toBe("OCD_KEYSTONE_HOST_AUTH")
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) expect(keystoneHostAuth({ OCD_KEYSTONE_HOST_AUTH: value })).toBe(false)
    expect(keystoneHostAuth({ OCD_KEYSTONE_HOST_AUTH: "1" })).toBe(true)
  })

  test("flag off: the generated servers.conf is byte-identical to before", () => {
    delete process.env[KEYSTONE_HOST_AUTH_ENV]
    expect(frontConfigHash(frontServersFor(defaultConfig({})))).toBe(BEFORE.defaultConfig)
    expect(frontConfigHash(frontServers(HOSTS, { host: IDENTITY, connections: CHOSEN }))).toBe(BEFORE.chosen)
    expect(frontConfigHash(frontServers(HOSTS, { host: IDENTITY, connections: [] }))).toBe(BEFORE.none)
    process.env[KEYSTONE_HOST_AUTH_ENV] = "0"
    expect(frontConfigHash(frontServers(HOSTS, { host: IDENTITY, connections: CHOSEN }))).toBe(BEFORE.chosen)
    expect(frontServers(HOSTS, { host: IDENTITY, connections: CHOSEN })).not.toContain("ks_auth")
  })

  test("the include directory is the generated mount", () => {
    expect(FRONT_INCLUDE_DIR).toBe(FRONT_GENERATED_MOUNT)
  })
})

/** The exact-match location blocks of the identity server lines. */
function exactBlocks(lines: string[]): Map<string, string> {
  const text = lines.join("\n")
  return new Map([...text.matchAll(/^ {4}location = (\S+) \{\n([\s\S]*?)\n {4}\}$/gm)].map((m) => [m[1] ?? "", m[2] ?? ""]))
}

describe("flag on: per-connection injection", () => {
  const lines = identityLocations(IDENTITY, CHOSEN, true)
  const blocks = exactBlocks(lines)

  test("only the chosen /mcp/c/<id> paths: no OAuth, token, registration or .well-known path (403 from `location /`)", () => {
    expect([...blocks.keys()]).toEqual(CHOSEN.map((id) => `/mcp/c/${id}`))
    expect(identityPaths(CHOSEN, true).map((p) => p.path)).toEqual(CHOSEN.map((id) => `/mcp/c/${id}`))
    const text = lines.join("\n")
    for (const { path: oauth } of KEYSTONE_OAUTH_PATHS) expect(text).not.toContain(oauth)
    expect(text).not.toContain(".well-known")
    expect(text).toContain("    location / {\n        return 403;\n    }")
  })

  test("each location clears $ks_auth, includes ONLY its own file, and sends it as Authorization", () => {
    for (const id of CHOSEN) {
      const body = blocks.get(`/mcp/c/${id}`)!
      const includes = [...body.matchAll(/include (\S+);/g)].map((m) => m[1])
      expect(includes).toEqual([`${FRONT_INCLUDE_DIR}/ks-auth-${id}.conf`, "/etc/nginx/front/upstream.conf"])
      const clear = body.indexOf('set $ks_auth "";')
      const include = body.indexOf(`include ${FRONT_INCLUDE_DIR}/ks-auth-${id}.conf;`)
      const header = body.indexOf("proxy_set_header Authorization $ks_auth;")
      expect(clear).toBeGreaterThan(-1)
      expect(include).toBeGreaterThan(clear)
      expect(header).toBeGreaterThan(include)
      expect(body).toContain('proxy_set_header x-api-key "";')
      expect([...body.matchAll(/proxy_pass (\S+);/g)].map((m) => m[1])).toEqual([`https://$front_upstream/mcp/c/${id}`])
      expect(body).toContain("limit_except GET POST DELETE { deny all; }")
      expect(body).toContain("if ($is_args) { return 403; }")
      for (const other of CHOSEN.filter((o) => o !== id)) expect(body).not.toContain(`ks-auth-${other}.conf`)
    }
  })

  test("through frontServers with the env flag; the synapse server is unchanged", () => {
    process.env[KEYSTONE_HOST_AUTH_ENV] = "1"
    const on = frontServers(HOSTS, { host: IDENTITY, connections: CHOSEN })
    delete process.env[KEYSTONE_HOST_AUTH_ENV]
    const off = frontServers(HOSTS, { host: IDENTITY, connections: CHOSEN })
    expect(on).toContain(`include ${FRONT_INCLUDE_DIR}/ks-auth-rag-read.conf;`)
    expect(on).not.toContain("/api/oidc/token")
    const synapse = (text: string) => text.slice(text.indexOf("server_name synapse2-api.alterspective.com.au;"))
    expect(synapse(on)).toBe(synapse(off))
    // The Keystone server never gets the Synapse token, and the synapse server no Keystone token.
    expect(on.slice(0, on.indexOf("server_name synapse2-api"))).not.toContain("synapse_auth")
    expect(synapse(on)).not.toContain("ks_auth")
  })

  test("no connections: nothing but the 403", () => {
    expect(exactBlocks(identityLocations(IDENTITY, [], true)).size).toBe(0)
    expect(() => identityLocations(IDENTITY, ["../x"], true)).toThrow()
  })
})
