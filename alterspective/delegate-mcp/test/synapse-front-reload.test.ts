// Review M1 (combined review of 90434eaaf5): the bridge reloads front ONLY through the baked
// `front-reload` script, which refuses (exit 3, no reload) when servers.conf is not the file front
// started with (OCD_FRONT_HASH) or the Synapse include is not the strict one-variable file. The
// entrypoint runs the same check at start (Low 4). The script is run here with `sh` and a fake
// `nginx` on PATH when `sh` and `flock` are available (Git Bash lacks flock).
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { KS_AUTH_VAR, MAX_TOKEN_LENGTH, authConf, isAuthConf } from "../src/synapse/auth-conf.ts"
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

  /** `before` runs just before the script, with the run directory (to plant leftovers). */
  type Step = { auth?: string; servers?: string; hash?: string; nginxTest?: number; args?: string[]; before?: (run: string) => void; ack?: false; ks?: Record<string, string> }
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
      // A `noack` file makes the worker never answer (exit 7 after OCD_FRONT_ACK_SECONDS).
      writeFileSync(wget, `#!/bin/sh\n[ -e '${path.join(dir, "noack").replaceAll("\\", "/")}' ] && exit 1\nmarker=$(sed -n 's|^include \\(.*attempts/.*\\.conf\\);$|\\1|p' "$OCD_FRONT_RUN/current.conf")\nsed -n 's|.*return 200 "\\([a-f0-9 ]*\\)".*|\\1|p' "$marker"\n`)
      chmodSync(wget, 0o755)
      return steps.map((opts) => {
        writeFileSync(path.join(gen, "servers.conf"), opts.servers ?? SERVERS)
        rmSync(path.join(gen, "synapse-auth.conf"), { force: true })
        if (opts.auth !== undefined) writeFileSync(path.join(gen, "synapse-auth.conf"), opts.auth)
        for (const name of readdirSync(gen)) if (name.startsWith("ks-auth-")) rmSync(path.join(gen, name), { force: true })
        for (const [id, text] of Object.entries(opts.ks ?? {})) writeFileSync(path.join(gen, `ks-auth-${id}.conf`), text)
        rmSync(calls, { force: true })
        writeFileSync(fake, `#!/bin/sh\necho "$*" >> '${calls.replaceAll("\\", "/")}'\n[ "$1" = "-t" ] && exit ${opts.nginxTest ?? 0}\nexit 0\n`)
        chmodSync(fake, 0o755)
        rmSync(path.join(dir, "noack"), { force: true })
        if (opts.ack === false) writeFileSync(path.join(dir, "noack"), "")
        opts.before?.(path.join(dir, "run"))
        const result = Bun.spawnSync([sh!, SCRIPT, ...(opts.args ?? [])], {
          env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, OCD_FRONT_GEN: gen.replaceAll("\\", "/"), OCD_FRONT_RUN: path.join(dir, "run").replaceAll("\\", "/"), OCD_FRONT_HASH: opts.hash ?? HASH, OCD_FRONT_ACK_SECONDS: "2" },
        })
        const current = path.join(dir, "run", "current.conf")
        const published = existsSync(current) ? readFileSync(current, "utf8") : undefined
        const loadedConf = path.join(dir, "run", "loaded.conf")
        const loaded = existsSync(loadedConf) ? readFileSync(loadedConf, "utf8") : undefined
        const list = (name: string) => (existsSync(path.join(dir, "run", name)) ? readdirSync(path.join(dir, "run", name)).sort() : [])
        // The published generation, its files and the marker's reply (#67 step 3 cases).
        const dest = /^include (.*)\/servers\.conf;$/m.exec(published ?? "")?.[1]
        const destFiles = dest && existsSync(dest) ? readdirSync(dest).sort() : []
        const destText = Object.fromEntries(destFiles.map((name) => [name, readFileSync(path.join(dest!, name), "utf8")]))
        const marker = /^include (.*attempts\/.*\.conf);$/m.exec(published ?? "")?.[1]
        const reply = marker && existsSync(marker) ? /return 200 "([^"]*)"/.exec(readFileSync(marker, "utf8"))?.[1] : undefined
        return { code: result.exitCode, stderr: result.stderr.toString(), nginx: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [], published, loaded, attempts: list("attempts"), generations: list("generations"), dest, destFiles, destText, reply }
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

  test("a refused attempt leaves no marker behind (it was never signalled)", () => {
    expect(run({ auth: authConf(undefined), nginxTest: 1 })).toMatchObject({ code: 4, attempts: [] })
  })

  test("leftovers older than ten minutes go at the next run; recent ones and what current.conf names stay", () => {
    const age = (file: string) => utimesSync(file, new Date(Date.now() - 20 * 60_000), new Date(Date.now() - 20 * 60_000))
    const [loaded, next] = runSteps([
      { auth: authConf(undefined) },
      {
        auth: authConf(TOKEN),
        nginxTest: 1,
        before: (runDir) => {
          // The loaded generation and marker are old too, but current.conf names them, so they stay.
          for (const name of readdirSync(path.join(runDir, "attempts"))) age(path.join(runDir, "attempts", name))
          for (const name of readdirSync(path.join(runDir, "generations"))) age(path.join(runDir, "generations", name))
          writeFileSync(path.join(runDir, "attempts", `${"a".repeat(32)}.conf`), "")
          age(path.join(runDir, "attempts", `${"a".repeat(32)}.conf`))
          writeFileSync(path.join(runDir, "attempts", `${"b".repeat(32)}.conf`), "")
          for (const name of ["deadbeef", ".stage.killed"]) {
            mkdirSync(path.join(runDir, "generations", name))
            age(path.join(runDir, "generations", name))
          }
        },
      },
    ])
    // Copied first: toMatchObject with an asymmetric matcher rewrites the received array in bun.
    const [attempts, generations] = [[...loaded!.attempts], [...loaded!.generations]]
    expect(loaded).toMatchObject({ code: 0, attempts: [expect.stringMatching(/^[0-9a-f]{32}\.conf$/)] })
    expect(next).toMatchObject({ code: 4, published: loaded!.published })
    expect(next!.attempts).toEqual([...attempts, `${"b".repeat(32)}.conf`].sort())
    expect(next!.generations).toEqual(expect.arrayContaining(generations))
    expect(next!.generations).not.toContain("deadbeef")
    expect(next!.generations).not.toContain(".stage.killed")
  })

  test("--start and an acknowledged reload record what workers load", () => {
    const start = run({ auth: authConf(TOKEN), args: ["--start"] })
    expect(start.loaded).toBe(start.published)
    const [, reloaded] = runSteps([{ auth: authConf(undefined) }, { auth: authConf(TOKEN) }])
    expect(reloaded).toMatchObject({ code: 0, loaded: reloaded!.published })
  })

  test("an unacknowledged reload keeps the old generation workers still serve, however old", () => {
    const age = (file: string) => utimesSync(file, new Date(Date.now() - 20 * 60_000), new Date(Date.now() - 20 * 60_000))
    const [served, pending, later] = runSteps([
      { auth: authConf(undefined) },
      { auth: authConf(TOKEN), ack: false },
      {
        auth: authConf(jwt({ sub: "oid-2" })),
        nginxTest: 1,
        before: (runDir) => {
          for (const sub of ["attempts", "generations"]) for (const name of readdirSync(path.join(runDir, sub))) age(path.join(runDir, sub, name))
        },
      },
    ])
    const [servedAttempts, servedGenerations] = [[...served!.attempts], [...served!.generations]]
    expect(pending).toMatchObject({ code: 7, loaded: served!.published })
    expect(pending!.published).not.toBe(served!.published)
    expect(later).toMatchObject({ code: 4, published: pending!.published, loaded: served!.published })
    // Both what workers serve (A) and what current.conf names (B) survive the age-based cleanup.
    expect(later!.attempts).toEqual(expect.arrayContaining([...servedAttempts, ...pending!.attempts]))
    expect(later!.generations).toEqual(expect.arrayContaining([...servedGenerations, ...pending!.generations]))
  })

  test("a restore that fails keeps the refused attempt's marker and says so", () => {
    const [loaded, refused] = runSteps([{ auth: authConf(undefined) }, { auth: authConf(TOKEN), nginxTest: 1, before: (runDir) => mkdirSync(path.join(runDir, "current.conf.restore")) }])
    const kept = [...loaded!.attempts]
    expect(refused).toMatchObject({ code: 4 })
    expect(refused!.stderr).toContain("could not be restored")
    expect(refused!.published).not.toBe(loaded!.published)
    expect(refused!.attempts).toHaveLength(2)
    expect(refused!.attempts).toEqual(expect.arrayContaining(kept))
  })

  // #67 step 3: per-connection Keystone includes (ks-auth-<id>.conf), named by servers.conf.
  const KS_SERVERS = [
    "server { listen 443;",
    "    location = /v1/models { set $synapse_auth \"\"; include /etc/nginx/front-gen/synapse-auth.conf; }",
    "    location = /mcp/c/rag-read {",
    '        set $ks_auth "";',
    "        include /etc/nginx/front-gen/ks-auth-rag-read.conf;",
    "    }",
    "    location = /mcp/c/github {",
    '        set $ks_auth "";',
    "        include /etc/nginx/front-gen/ks-auth-github.conf;",
    "    }",
    "}",
    "",
  ].join("\n")
  const KS_HASH = sha(KS_SERVERS)
  const ksStep = (opts: Step = {}): Step => ({ servers: KS_SERVERS, hash: KS_HASH, auth: authConf(undefined), ...opts })
  const KS_TOKEN = jwt({ sub: "oid-1", aud: "https://identity.alterspective.com.au/mcp/c/rag-read" })

  test("flag off (no ks include in servers.conf): the reply and generation keep their three-part form", () => {
    const result = run({ auth: authConf(TOKEN) })
    expect(result.code).toBe(0)
    expect(result.reply).toMatch(new RegExp(`^[0-9a-f]{32} ${HASH} ${sha(authConf(TOKEN))}$`))
    expect(result.dest!.endsWith(`/${HASH}-${sha(authConf(TOKEN))}`)).toBe(true)
    expect(result.destFiles).toEqual(["servers.conf", "source-servers.conf", "synapse-auth.conf"])
  })

  test("each named include is checked, copied into the generation, and hashed into a fourth reply field", () => {
    const rag = authConf(KS_TOKEN, KS_AUTH_VAR)
    // github has no file yet: the empty include is staged (fail closed: Keystone answers 401).
    // An include servers.conf does not name is ignored, whatever it holds.
    const result = run(ksStep({ ks: { "rag-read": rag, stray: "proxy_pass https://evil;\n" } }))
    const empty = authConf(undefined, KS_AUTH_VAR)
    const list = `ks-auth-github.conf ${sha(empty)}\nks-auth-rag-read.conf ${sha(rag)}\n`
    expect(result).toMatchObject({ code: 0, nginx: ["-t -q", "-s reload"] })
    expect(result.destFiles).toEqual(["ks-auth-github.conf", "ks-auth-rag-read.conf", "ks-auth.list", "servers.conf", "source-servers.conf", "synapse-auth.conf"])
    expect(result.destText["ks-auth-rag-read.conf"]).toBe(rag)
    expect(result.destText["ks-auth-github.conf"]).toBe(empty)
    expect(result.destText["ks-auth.list"]).toBe(list)
    expect(result.dest!.endsWith(`/${KS_HASH}-${sha(authConf(undefined))}-${sha(list)}`)).toBe(true)
    expect(result.reply).toMatch(new RegExp(`^[0-9a-f]{32} ${KS_HASH} ${sha(authConf(undefined))} ${sha(list)}$`))
    // Every include names the immutable generation, never the mutable host folder.
    const servers = result.destText["servers.conf"]!
    expect(servers).not.toContain("/etc/nginx/front-gen/")
    expect(servers).toContain(`include ${result.dest}/ks-auth-rag-read.conf;`)
    expect(servers).toContain(`include ${result.dest}/ks-auth-github.conf;`)
    expect(result.stderr).not.toContain(KS_TOKEN)
  })

  test("--check and --start cover the ks includes too", () => {
    expect(run(ksStep({ ks: { "rag-read": authConf(KS_TOKEN, KS_AUTH_VAR) }, args: ["--check"] }))).toMatchObject({ code: 0, nginx: [], published: undefined })
    expect(run(ksStep({ ks: { github: `${authConf(KS_TOKEN, KS_AUTH_VAR)}x` }, args: ["--check"] }))).toMatchObject({ code: 3, nginx: [] })
    const start = run(ksStep({ ks: { "rag-read": authConf(KS_TOKEN, KS_AUTH_VAR) }, args: ["--start"] }))
    expect(start).toMatchObject({ code: 0, nginx: [] })
    expect(start.loaded).toBe(start.published)
    expect(start.destFiles).toContain("ks-auth.list")
  })

  test("a ks include that is not the strict one-variable file: exit 3, nginx never runs, its text never printed", () => {
    const good = authConf(KS_TOKEN, KS_AUTH_VAR)
    const [header, line] = good.split("\n")
    const bad = {
      extraLine: `${good}proxy_pass https://evil;\n`,
      injected: `${header}\nset $ks_auth "Bearer ${KS_TOKEN}"; proxy_pass https://evil;\n`,
      synapseVariable: authConf(KS_TOKEN),
      otherVariable: `${header}\nset $front_upstream "evil";\n`,
      noTrailingNewline: good.slice(0, -1),
      crlf: good.replaceAll("\n", "\r\n"),
      headerChanged: good.replace("Do not edit", "Edit freely"),
      quoteInside: `${header}\nset $ks_auth "Bearer ${KS_TOKEN}\\"";\n`,
      tooLong: authConf(undefined, KS_AUTH_VAR).replace('""', `"Bearer ${"a".repeat(2000)}.${"b".repeat(2000)}.${"c".repeat(100)}"`),
      emptyLine: `${header}\n\n${line}\n`,
    }
    for (const [name, text] of Object.entries(bad)) {
      expect({ name, ts: isAuthConf(text, KS_AUTH_VAR) }).toEqual({ name, ts: false })
      const result = run(ksStep({ ks: { "rag-read": authConf(undefined, KS_AUTH_VAR), github: text } }))
      expect({ name, code: result.code, nginx: result.nginx, published: result.published }).toEqual({ name, code: 3, nginx: [], published: undefined })
      expect(result.stderr).not.toContain(KS_TOKEN)
    }
  })

  test("a connection id containing `front-gen` reloads fine (review cycle 1: no double count)", () => {
    // The id also appears outside the include lines (location and proxy_pass), as generated.
    const servers = KS_SERVERS.replaceAll("github", "my-front-gen").replace("    location = /mcp/c/my-front-gen {\n", "    location = /mcp/c/my-front-gen {\n        proxy_pass https://$front_upstream/mcp/c/my-front-gen;\n")
    expect(servers).toContain("proxy_pass https://$front_upstream/mcp/c/my-front-gen;")
    const result = run({ servers, hash: sha(servers), auth: authConf(undefined), ks: { "my-front-gen": authConf(KS_TOKEN, KS_AUTH_VAR) } })
    expect(result).toMatchObject({ code: 0, nginx: ["-t -q", "-s reload"] })
    expect(result.destFiles).toContain("ks-auth-my-front-gen.conf")
    expect(result.destText["servers.conf"]).toContain(`include ${result.dest}/ks-auth-my-front-gen.conf;`)
    expect(run({ servers, hash: sha(servers), auth: authConf(undefined), args: ["--start"] })).toMatchObject({ code: 0 })
  })

  test("servers.conf naming any other generated file is refused (nginx would read the host folder directly)", () => {
    const odd = KS_SERVERS.replace("ks-auth-github.conf", "ks-auth-GitHub.conf")
    expect(run({ servers: odd, hash: sha(odd), auth: authConf(undefined) })).toMatchObject({ code: 3, nginx: [] })
    const other = KS_SERVERS.replace("ks-auth-github.conf", "evil.conf")
    expect(run({ servers: other, hash: sha(other), auth: authConf(undefined) })).toMatchObject({ code: 3, nginx: [] })
    // Review cycle 2: non-canonical spellings of the host folder nginx would still resolve.
    for (const spelling of ["include /etc/nginx//front-gen/evil.conf;", "include /etc/nginx/./front-gen/evil.conf;", "include front-gen/evil.conf;"]) {
      const odd2 = KS_SERVERS.replace("}\n", `    location = /x { ${spelling} }\n}\n`)
      expect(odd2).toContain(spelling)
      for (const args of [[], ["--check"], ["--start"]])
        expect({ spelling, args, code: run({ servers: odd2, hash: sha(odd2), auth: authConf(undefined), args }).code }).toEqual({ spelling, args, code: 3 })
    }
  })

  test("a token change in one ks include makes a new generation; the old one goes after the acknowledgement", () => {
    const [first, second] = runSteps([ksStep({ ks: { "rag-read": authConf(undefined, KS_AUTH_VAR) } }), ksStep({ ks: { "rag-read": authConf(KS_TOKEN, KS_AUTH_VAR) } })])
    expect(first).toMatchObject({ code: 0 })
    expect(second).toMatchObject({ code: 0, loaded: second!.published })
    expect(second!.dest).not.toBe(first!.dest)
    expect(second!.generations).toEqual([path.basename(second!.dest!)])
  })
})
