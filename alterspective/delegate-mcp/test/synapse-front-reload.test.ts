// Review M1 (combined review of 90434eaaf5): the bridge reloads front ONLY through the baked
// `front-reload` script, which refuses (exit 3, no reload) when servers.conf is not the file front
// started with (OCD_FRONT_HASH) or the Synapse include is not the strict one-variable file. The
// entrypoint runs the same check at start (Low 4). The script is run here with `sh` and a fake
// `nginx` on PATH when `sh` and `flock` are available (Git Bash lacks flock).
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { MAX_TOKEN_LENGTH, authConf, isAuthConf } from "../src/synapse/auth-conf.ts"
import { jwt } from "./synapse-fixture.ts"

const FRONT = path.join(import.meta.dir, "..", "docker", "front")
const SCRIPT = path.join(FRONT, "front-reload.sh")
const read = (name: string) => readFileSync(path.join(FRONT, name), "utf8")

describe("front-reload is baked into front and is the only reload path", () => {
  test("the Dockerfile installs it executable and strips CR; the entrypoint checks before nginx starts", () => {
    const dockerfile = read("Dockerfile")
    expect(dockerfile).toMatch(/apk add --no-cache[^\n]*\bflock\b/)
    expect(dockerfile).toContain("COPY --chmod=0755 front-reload.sh /usr/local/bin/front-reload")
    expect(dockerfile).toMatch(/sed -i 's\/\\r\$\/\/' [^\n]*\/usr\/local\/bin\/front-reload/)
    const entry = read("entrypoint.sh")
    const check = entry.indexOf("/usr/local/bin/front-reload --start")
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(entry.indexOf("exec nginx"))
  })

  test("the script's header and size limit are the bridge's (auth-conf.ts)", () => {
    const script = readFileSync(SCRIPT, "utf8")
    const header = authConf(undefined).split("\n")[0]!
    expect(script).toContain(`HEADER='${header}'`)
    expect(script).toContain(`MAX_BYTES=${header.length + MAX_TOKEN_LENGTH + 40}`)
    // It never prints the include (no cat/head/tail of it), and silences nginx's own output.
    expect(script).not.toMatch(/\b(cat|head|tail)\b[^\n]*\$AUTH/)
    expect(script).toContain("nginx -t -q > /dev/null 2>&1")
  })
})

const sh = Bun.which("sh")
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

describe.skipIf(!sh || !Bun.which("flock"))("front-reload run with sh (fake nginx)", () => {
  const SERVERS = "server { listen 443; }\n"
  const HASH = createHash("sha256").update(SERVERS).digest("hex")
  const TOKEN = jwt({ sub: "oid-1" })

  type Step = { auth?: string; servers?: string; hash?: string; nginxTest?: number; args?: string[] }
  const run = (opts: Step = {}) => runSteps([opts])[0]!

  /** Runs the script once per step in one directory, so a later step sees an earlier step's files. */
  function runSteps(steps: Step[]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ocd-front-reload-"))
    try {
      const gen = path.join(dir, "gen")
      const bin = path.join(dir, "bin")
      for (const d of [gen, bin]) mkdirSync(d)
      const calls = path.join(dir, "calls.txt")
      const fake = path.join(bin, "nginx")
      // A worker acknowledges the published generation. The real-nginx pause/race proof lives
      // in spike/review-reload-proof.ts; these cases exercise malformed files and shell exits.
      const wget = path.join(bin, "wget")
      writeFileSync(wget, `#!/bin/sh\nmarker=$(sed -n 's|^include \\(.*attempts/.*\\.conf\\);$|\\1|p' "$OCD_FRONT_RUN/current.conf")\nsed -n 's|.*return 200 "\\([a-f0-9]* [a-f0-9]* [a-f0-9]*\\)".*|\\1|p' "$marker"\n`)
      chmodSync(wget, 0o755)
      return steps.map((opts) => {
        writeFileSync(path.join(gen, "servers.conf"), opts.servers ?? SERVERS)
        rmSync(path.join(gen, "synapse-auth.conf"), { force: true })
        if (opts.auth !== undefined) writeFileSync(path.join(gen, "synapse-auth.conf"), opts.auth)
        rmSync(calls, { force: true })
        writeFileSync(fake, `#!/bin/sh\necho "$*" >> '${calls.replaceAll("\\", "/")}'\n[ "$1" = "-t" ] && exit ${opts.nginxTest ?? 0}\nexit 0\n`)
        chmodSync(fake, 0o755)
        const result = Bun.spawnSync([sh!, SCRIPT, ...(opts.args ?? [])], {
          env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, OCD_FRONT_GEN: gen.replaceAll("\\", "/"), OCD_FRONT_RUN: path.join(dir, "run").replaceAll("\\", "/"), OCD_FRONT_HASH: opts.hash ?? HASH },
        })
        const current = path.join(dir, "run", "current.conf")
        const published = existsSync(current) ? readFileSync(current, "utf8") : undefined
        return { code: result.exitCode, stderr: result.stderr.toString(), nginx: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [], published }
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("the files front started with: nginx -t, then reload (exit 0); with a token too, up to the longest", () => {
    expect(run({ auth: authConf(undefined) })).toMatchObject({ code: 0, nginx: ["-t -q", "-s reload"], published: expect.stringContaining(`${HASH}-${sha(authConf(undefined))}/servers.conf;`) })
    expect(run({ auth: authConf(TOKEN) })).toMatchObject({ code: 0, nginx: ["-t -q", "-s reload"], published: expect.stringContaining(`${HASH}-${sha(authConf(TOKEN))}/servers.conf;`) })
    const longest = `${"a".repeat(100)}.${"b".repeat(MAX_TOKEN_LENGTH - 202)}.${"c".repeat(100)}`
    expect(isAuthConf(authConf(longest))).toBe(true)
    expect(run({ auth: authConf(longest) })).toMatchObject({ code: 0, nginx: ["-t -q", "-s reload"] })
  })

  test("--check only checks; --start prepares an immutable generation without claiming it is loaded", () => {
    expect(run({ auth: authConf(TOKEN), args: ["--check"] })).toMatchObject({ code: 0, nginx: [], published: undefined })
    expect(run({ auth: authConf(TOKEN), args: ["--check"], hash: "0".repeat(64) })).toMatchObject({ code: 3, nginx: [] })
    expect(run({ auth: authConf(TOKEN), args: ["--start"] })).toMatchObject({ code: 0, nginx: [], published: expect.stringContaining(`${HASH}-${sha(authConf(TOKEN))}/servers.conf;`) })
    expect(run({ auth: `${authConf(TOKEN)}x`, args: ["--start"] })).toMatchObject({ code: 3, nginx: [], published: undefined })
  })

  test("servers.conf is not the file front started with: exit 3, nginx never runs", () => {
    const changed = run({ auth: authConf(undefined), servers: "server { listen 443; proxy_pass https://evil; }\n" })
    expect(changed).toMatchObject({ code: 3, nginx: [] })
    expect(changed.stderr).toContain("OCD_FRONT_HASH")
    expect(run({ auth: authConf(undefined), hash: "" })).toMatchObject({ code: 3, nginx: [] })
  })

  test("an include that is not the strict one-variable file: exit 3, nginx never runs, its text never printed", () => {
    const good = authConf(TOKEN)
    const [header, line] = good.split("\n")
    const bad = {
      missing: undefined,
      extraLine: `${good}proxy_pass https://evil;\n`,
      injected: `${header}\nset $synapse_auth "Bearer ${TOKEN}"; proxy_pass https://evil;\n`,
      otherVariable: `${header}\nset $front_upstream "evil";\n`,
      noTrailingNewline: good.slice(0, -1),
      trailingText: `${good}x`,
      crlf: good.replaceAll("\n", "\r\n"),
      headerChanged: good.replace("Do not edit", "Edit freely"),
      quoteInside: `${header}\nset $synapse_auth "Bearer ${TOKEN}\\"";\n`,
      tooLong: authConf(undefined).replace('""', `"Bearer ${"a".repeat(2000)}.${"b".repeat(2000)}.${"c".repeat(100)}"`),
      emptyLine: `${header}\n\n${line}\n`,
    }
    for (const [name, auth] of Object.entries(bad)) {
      if (auth !== undefined) expect({ name, ts: isAuthConf(auth) }).toEqual({ name, ts: false })
      const result = auth === undefined ? run({}) : run({ auth })
      expect({ name, code: result.code, nginx: result.nginx, published: result.published }).toEqual({ name, code: 3, nginx: [], published: undefined })
      expect(result.stderr).not.toContain(TOKEN)
    }
  })

  test("nginx -t refuses: exit 4 and no reload (front keeps the last good config)", () => {
    expect(run({ auth: authConf(undefined), nginxTest: 1 })).toMatchObject({ code: 4, nginx: ["-t -q"], published: undefined })
    // current.conf goes back to the last target, never the config nginx refused.
    const [loaded, refused] = runSteps([{ auth: authConf(undefined) }, { auth: authConf(TOKEN), nginxTest: 1 }])
    expect(loaded).toMatchObject({ code: 0, published: expect.stringContaining(`${HASH}-${sha(authConf(undefined))}/servers.conf;`) })
    expect(refused).toMatchObject({ code: 4, nginx: ["-t -q"], published: loaded!.published })
  })
})
