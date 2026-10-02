// #49 compiled-container canaries. Run only against a task-created scratch Compose box.
// Usage: bun spike/code-loader-proof.ts <project> <box> <baseline|fixed>
// Every child listener gets private scratch state and a fixture credential. No real gate token
// enters the box, no model API is called, and output contains only paths, statuses and booleans.
import { execFileSync } from "node:child_process"

const [project, box, mode] = process.argv.slice(2)
if (
  !project ||
  !box ||
  !mode ||
  project === "opencode-delegate" ||
  box === "opencode-delegate" ||
  !["baseline", "fixed"].includes(mode)
) {
  throw new Error("Supply a task-created scratch project, box, and baseline|fixed mode")
}
const inspect = JSON.parse(execFileSync("docker", ["inspect", box], { encoding: "utf8" }))[0]
if (
  inspect.Config.Labels["com.docker.compose.project"] !== project ||
  inspect.Config.Labels["com.docker.compose.service"] !== "box"
) {
  throw new Error("Scratch project/service labels do not match")
}
const child = Bun.spawn(["docker", "exec", "-i", box, "node", "-"], {
  env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
})
child.stdin.write(
  `(${inside.toString()})(${JSON.stringify(mode)}).then(x => console.log(JSON.stringify(x))).catch(() => { console.log(JSON.stringify({ proofError: true })); process.exitCode = 1 })`,
)
child.stdin.end()
const [stdout, stderr, exit] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
])
if (stderr) console.error(JSON.stringify({ childStderrPresent: true }))
if (stdout) console.log(stdout.trim())
if (exit !== 0) process.exit(exit)
const result = JSON.parse(stdout)
if (!result.passed) process.exit(1)

async function inside(mode: string) {
  const fs = await import("node:fs/promises")
  const crypto = await import("node:crypto")
  const http = await import("node:http")
  const cp = await import("node:child_process")
  const urls = await import("node:url")
  const root = await fs.mkdtemp("/sessions/code-loader-")
  const reports: Record<string, unknown>[] = []
  const checks = ["workspace-plugin", "wellknown-config", "account-config", "provider-profile", "provider-cache", "trusted-inbox"]
  if (process.env.OPENCODE_DISABLE_PROJECT_CONFIG !== "1") throw new Error("Project config guard absent")
  if (
    mode === "fixed" &&
    (process.env.OPENCODE_DISABLE_REMOTE_CONFIG !== "1" || process.env.OPENCODE_DISABLE_EXTERNAL_PROVIDERS !== "1")
  ) {
    throw new Error("Code loader guards absent")
  }
  const homeFile = `/home/agent/.opencode/code-loader-${crypto.randomUUID()}`
  const homeProtected = await fs.stat("/home/agent/.opencode").then(
    (value) => value.isDirectory() && value.uid === 0 && (value.mode & 0o222) === 0,
    () => false,
  )
  const homeWriteDenied = await fs.writeFile(homeFile, "canary", { flag: "wx" }).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "EACCES" || error.code === "EROFS",
  )
  if (!homeWriteDenied) await fs.unlink(homeFile).catch(() => undefined) // Only this proof-created path.
  const homeReadonly = homeProtected && homeWriteDenied

  for (const name of checks) {
    const dir = `${root}/${name}`
    const cwd = `${dir}/workspace`
    const cfg = `${dir}/config/opencode`
    const cache = `${dir}/cache/opencode`
    const data = `${dir}/data/opencode`
    const marker = `${dir}/executed`
    const source = `${dir}/canary.ts`
    await Promise.all(
      [cwd, cfg, cache, data, `${dir}/state`, `${dir}/home`].map((x) => fs.mkdir(x, { recursive: true })),
    )
    const provider = name.startsWith("provider-")
    await fs.writeFile(
      source,
      name === "trusted-inbox"
        ? `import inbox from "/profile/opencode/plugin/inbox.ts";
export default async function (input) {
  const hooks = await inbox(input);
  setTimeout(async () => {
    try {
      const parent = await input.client.session.create({body:{title:"Trusted inbox parent",metadata:{supervisor:"supervisor:proof"}}});
      const child = await input.client.session.create({body:{title:"Trusted inbox child",parentID:parent.data.id}});
      const result = await hooks.tool.message_supervisor.execute({text:"Fixture inbox proof",correlationId:"new"},{sessionID:child.data.id,directory:input.directory});
      await Bun.write(${JSON.stringify(marker)}, JSON.stringify({parentStatus:parent.response.status,childStatus:child.response.status,delivered:result.includes("to supervisor:proof ")}));
    } catch { await Bun.write(${JSON.stringify(marker)}, JSON.stringify({delivered:false})); }
  }, 0);
  return {};
}`
        : provider
        ? `await Bun.write(${JSON.stringify(marker)}, "executed"); throw new Error("code-loader canary stopped before model network")`
        : `export default async function () { await Bun.write(${JSON.stringify(marker)}, "executed"); return {} }`,
    )
    const sourceURL = urls.pathToFileURL(source).href
    const hits: string[] = []
    const remote = http.createServer((request, response) => {
      hits.push(request.url ?? "unknown")
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ config: { plugin: [sourceURL] } }))
    })
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve))
    const remoteAddress = remote.address()
    if (!remoteAddress || typeof remoteAddress === "string") throw new Error("No remote fixture port")
    const remoteURL = `http://127.0.0.1:${remoteAddress.port}`
    const config: Record<string, unknown> = {
      formatter: false,
      lsp: false,
      autoupdate: false,
      snapshot: false,
      share: "disabled",
    }
    if (name === "trusted-inbox") config.plugin = [sourceURL]
    if (provider) {
      config.enabled_providers = ["canary"]
      config.model = "canary/test"
      config.small_model = "canary/test"
      config.provider = {
        canary: {
          options: { apiKey: "fixture-only" },
          ...(name === "provider-profile" ? { npm: sourceURL, models: { test: { name: "Canary" } } } : {}),
        },
      }
    }
    await fs.writeFile(`${cfg}/opencode.json`, JSON.stringify(config))
    if (name === "workspace-plugin") {
      await fs.mkdir(`${cwd}/.opencode/plugin`, { recursive: true })
      await fs.copyFile(source, `${cwd}/.opencode/plugin/canary.ts`)
      await fs.writeFile(`${cwd}/opencode.json`, JSON.stringify({ plugin: [sourceURL] }))
    }
    if (name === "wellknown-config") {
      await fs.writeFile(
        `${data}/auth.json`,
        JSON.stringify({ [remoteURL]: { type: "wellknown", key: "CANARY_REMOTE_KEY", token: "fixture-only" } }),
      )
    }
    if (name === "provider-cache") {
      await fs.writeFile(
        `${cache}/models.json`,
        JSON.stringify({
          canary: {
            id: "canary",
            name: "Canary",
            env: [],
            npm: sourceURL,
            models: {
              test: {
                id: "test",
                name: "Canary",
                release_date: "2026-01-01",
                attachment: false,
                reasoning: false,
                temperature: false,
                tool_call: true,
                limit: { context: 8192, output: 512 },
                modalities: { input: ["text"], output: ["text"] },
              },
            },
          },
        }),
      )
    }

    const portProbe = http.createServer()
    await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve))
    const address = portProbe.address()
    if (!address || typeof address === "string") throw new Error("No API fixture port")
    const port = address.port
    await new Promise<void>((resolve) => portProbe.close(() => resolve()))
    const password = crypto.randomBytes(32).toString("base64url")
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: `${dir}/home`,
      XDG_CONFIG_HOME: `${dir}/config`,
      XDG_DATA_HOME: `${dir}/data`,
      XDG_CACHE_HOME: `${dir}/cache`,
      XDG_STATE_HOME: `${dir}/state`,
      OPENCODE_CONFIG_DIR: cfg,
      OPENCODE_DB: `${dir}/fixture.db`,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD_SHA256: crypto.createHash("sha256").update(password).digest("hex"),
    }
    delete env.OPENCODE_SERVER_PASSWORD
    delete env.OPENCODE_AUTH_CONTENT
    delete env.OPENCODE_CONFIG
    delete env.OPENCODE_CONFIG_CONTENT
    delete env.OPENCODE_MODELS_PATH
    delete env.OPENCODE_MODELS_URL
    delete env.OPENCODE_TEST_HOME
    if (mode === "baseline") {
      delete env.OPENCODE_SERVER_PASSWORD_SHA256
      env.OPENCODE_SERVER_PASSWORD = password
      delete env.OPENCODE_DISABLE_REMOTE_CONFIG
      delete env.OPENCODE_DISABLE_EXTERNAL_PROVIDERS
    }
    const server = cp.spawn("/usr/local/bin/opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let logs = ""
    server.stdout.on("data", (chunk) => {
      logs += String(chunk)
    })
    server.stderr.on("data", (chunk) => {
      logs += String(chunk)
    })
    const call = (route: string, directory: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${port}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          "x-opencode-directory": directory,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      })
    const exists = () =>
      fs.stat(marker).then(
        () => true,
        () => false,
      )
    let stage = "server-start"
    try {
      let ready = false
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await call("/global/health", cwd).catch(() => undefined)
        if (response?.status === 200) {
          ready = true
          break
        }
        if (server.exitCode !== null) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (!ready) throw new Error("Fixture server did not start")
      if (name === "account-config") {
        stage = "seed-account"
        const warm = await call("/config", cwd)
        if (warm.status !== 200) throw new Error("Fixture database did not start")
        const sql = [
          "import { Database } from 'bun:sqlite'",
          `const db = new Database(${JSON.stringify(env.OPENCODE_DB)})`,
          "db.exec('PRAGMA busy_timeout=5000')",
          `db.query('INSERT INTO account (id,email,url,access_token,refresh_token,token_expiry,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?)').run('code-loader-account','fixture@localhost',${JSON.stringify(remoteURL)},'fixture-only','fixture-only',Date.now()+3600000,Date.now(),Date.now())`,
          "db.query('INSERT INTO account_state (id,active_account_id,active_org_id) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET active_account_id=excluded.active_account_id,active_org_id=excluded.active_org_id').run('code-loader-account','code-loader-org')",
          "db.close()",
        ].join("\n")
        cp.execFileSync("/usr/local/bin/bun", ["-e", sql], { env, stdio: ["ignore", "pipe", "pipe"] })
      }
      const fresh = `${dir}/fresh`
      await fs.mkdir(fresh)
      stage = "config-read"
      const configResponse = await call("/config", name === "account-config" ? fresh : cwd)
      await configResponse.text()
      let trusted: { parentStatus?: number; childStatus?: number; delivered?: boolean } | undefined
      if (name === "trusted-inbox") {
        stage = "trusted-inbox"
        for (let attempt = 0; attempt < 100 && !(await exists()); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        trusted = JSON.parse(await fs.readFile(marker, "utf8"))
      }
      let selected = false
      let promptStatus: number | undefined
      let promptBody = ""
      if (provider) {
        stage = "provider-selection"
        const listed = await call("/provider", cwd)
        const listing = await listed.json()
        selected =
          listing.all?.some(
            (item: { id: string; models?: Record<string, { api?: { npm?: string } }> }) =>
              item.id === "canary" && item.models?.test?.api?.npm === sourceURL,
          ) === true
        if (!selected) throw new Error("Fixture provider was not selected")
        stage = "session-create"
        const made = await call("/session", cwd, {
          title: "Code loader canary",
          permission: [{ permission: "*", pattern: "*", action: "deny" }],
        })
        const session = await made.json()
        if (typeof session.id !== "string") throw new Error("No fixture session")
        stage = "provider-import"
        const prompt = await call(`/session/${session.id}/message`, cwd, {
          model: { providerID: "canary", modelID: "test" },
          parts: [{ type: "text", text: "Local module canary only; do not use tools." }],
        })
        promptStatus = prompt.status
        promptBody = await prompt.text()
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
      const executed = await exists()
      const expectExecution = name === "trusted-inbox" || (mode === "baseline" && name !== "workspace-plugin")
      const denied =
        logs.includes("External provider modules are disabled") ||
        promptBody.includes("External provider modules are disabled")
      reports.push({
        name,
        configStatus: configResponse.status,
        remoteRequests: hits.length,
        executed,
        providerSelected: provider ? selected : undefined,
        promptStatus,
        externalProviderRejected: provider ? denied : undefined,
        trustedInbox: trusted,
        passed:
          configResponse.status === 200 &&
          executed === expectExecution &&
          (!provider || mode === "baseline" || denied) &&
          (name !== "trusted-inbox" || (trusted?.parentStatus === 200 && trusted.childStatus === 200 && trusted.delivered === true)) &&
          (name.endsWith("config") ? (expectExecution ? hits.length > 0 : hits.length === 0) : true),
      })
    } catch {
      reports.push({
        name,
        failedStage: stage,
        remoteRequests: hits.length,
        executed: await exists(),
        serverExited: server.exitCode !== null,
        passed: false,
      })
    } finally {
      // Exact process handle created above; no name or process-group kill.
      if (server.exitCode === null) server.kill("SIGTERM")
      await Promise.race([
        new Promise<void>((resolve) => server.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ])
      if (server.exitCode === null) server.kill("SIGKILL")
      await new Promise<void>((resolve) => remote.close(() => resolve()))
    }
  }
  return { mode, root, homeReadonly, reports, passed: homeReadonly && reports.every((x) => x.passed === true) }
}
