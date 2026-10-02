// #49: real session-shell proof in a new, disposable Compose project. No owner credentials.
// Run through the work queue: bun spike/session-isolation-proof.ts <baseline|fixed>
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import { createApi, expectOk } from "../src/shared/opencode-api.ts"

const mode = process.argv[2]
assert.ok(mode === "baseline" || mode === "fixed", "Choose baseline or fixed")
const repoRoot = mode === "baseline" ? "C:/GitHub/opencode" : path.resolve(import.meta.dir, "../../..")
const moduleURL = (name: string) => pathToFileURL(path.join(repoRoot, "alterspective/delegate-mcp/src", name)).href
const { defaultConfig } = await import(moduleURL("shared/config.ts"))
const { createGuard } = await import(moduleURL("guard/index.ts"))
const { createSupervisor, defaultSupervisorDeps, composeDownEnv } = await import(moduleURL("supervisor/lifecycle.ts"))
const project = `ocd-api-proof-${randomUUID().slice(0, 8)}`
const home = await mkdtemp(path.join(os.tmpdir(), `${project}-`))
const ownerConfigDir = path.join(home, "owner-config")
await mkdir(ownerConfigDir)
await writeFile(path.join(ownerConfigDir, "opencode.json"), JSON.stringify({
  model: "synapse/auto",
  provider: { synapse: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://synapse2-api.alterspective.com.au/v1" }, models: { auto: { name: "Proof model", limit: { context: 100000, output: 1000 } } } } },
}))
const config = { ...defaultConfig({}), home, project, keystoneConnections: [], keystoneAllowed: [], roots: [repoRoot] }
const deps = await defaultSupervisorDeps(config, { repoRoot, ownerConfigDir, bridgeId: `proof-${randomUUID()}`, permission: createGuard(config).permissionBaseline("standard") })
const supervisor = createSupervisor(deps)
const adopter = createSupervisor({ ...deps, bridgeId: `adopter-${randomUUID()}` })
console.log(JSON.stringify({ phase: "start", mode, project, home, image: deps.image }))
try {
  const target = await supervisor.ensure()
  const api = createApi(target)
  const directories = ["/sessions/proof-a", "/sessions/proof-b"]
  const madeDirs = await deps.exec(["docker", "exec", project, "mkdir", "-p", ...directories], { timeoutMs: 15000 })
  assert.equal(madeDirs.code, 0, "Create scratch directories")
  const sessions = []
  for (const [index, directory] of directories.entries()) {
    const made = expectOk(await api.call<{ id: string }>({ method: "POST", path: "/session", directory, body: { title: `API isolation proof ${index}`, permission: [{ permission: "*", pattern: "*", action: "allow" }] } }), "create proof session")
    assert.equal(typeof made.id, "string")
    sessions.push(made.id)
  }
  const python = `try:\n${shellProof(sessions[1]!, directories[1]!).split("\n").map((line) => `    ${line}`).join("\n")}\nexcept Exception as error:\n    print("OCD_FAILURE=" + type(error).__name__, flush=True)`
  // Shell.args wraps Bash commands in eval + JSON.stringify. A heredoc's newlines do not
  // survive that wrapper. Keep the shell command on one line; decode only inside Python.
  const command = `python3 -I -S -c 'import base64; exec(base64.b64decode("${Buffer.from(python).toString("base64")}"))'`
  const shell = expectOk(await api.call<{ info: { id: string; time: { completed?: number } }; parts: { type: string; state?: { status?: string; output?: string; metadata?: { output?: string } } }[] }>({
    method: "POST", path: `/session/${sessions[0]}/shell`, directory: directories[0],
    body: { agent: "build", model: { providerID: "synapse", modelID: "auto" }, command }, timeoutMs: 60000,
  }), "run actual session shell")
  const output = shell.parts.filter((part) => part.type === "tool").map((part) => part.state?.output ?? "").join("\n")
  const line = output.split(/\r?\n/).find((value) => value.startsWith("OCD_PROOF="))
  console.log(JSON.stringify({ phase: "shell-response", completed: Boolean(shell.info.time.completed),
    parts: shell.parts.map((part) => ({ type: part.type, status: part.state?.status,
      outputBytes: part.state?.output?.length ?? 0, metadataBytes: part.state?.metadata?.output?.length ?? 0 })),
    failureType: output.match(/^OCD_FAILURE=([A-Za-z]+)$/m)?.[1],
    commandMissing: /(?:not found|No such file)/.test(output),
    pythonSyntaxError: /SyntaxError:/.test(output) }))
  assert.ok(line, "Session shell returned the safe proof record")
  const proof = JSON.parse(line.slice("OCD_PROOF=".length))
  console.log(JSON.stringify({ phase: "session-shell", mode, ...proof }))
  if (mode === "baseline") {
    assert.equal(proof.envPassword, true)
    assert.equal(proof.procPassword, true)
    assert.equal(proof.otherSessionStatus, 200)
    assert.equal(proof.otherSessionMatched, true)
  }
  if (mode === "fixed") {
    assert.equal(proof.envPassword, false)
    assert.equal(proof.procPassword, false)
    assert.equal(proof.verifierPresent, true)
    assert.equal(proof.otherSessionStatus, 401)
    assert.ok(proof.denials.every((item: { status: number }) => item.status === 401))
    assert.equal(proof.gateStatus, 401)
    assert.equal(proof.memoryGuardPassed, true)
  }
  const adopted = await adopter.ensure()
  assert.equal(adopted.baseUrl, target.baseUrl)
  assert.ok(adopted.password === target.password, "Adoption retained host authority")
  const legitimate = await api.call<{ id: string }>({ path: `/session/${sessions[1]}`, directory: directories[1] })
  assert.equal(legitimate.status, 200)
  assert.equal(legitimate.data?.id, sessions[1])
  console.log(JSON.stringify({ phase: "host-authority", adopted: true, otherSessionStatus: legitimate.status }))
  if (mode === "fixed") {
    for (const control of ["baseline", "fixed"]) {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "code-loader-proof.ts"), project, project, control], { env: { ...process.env, MSYS_NO_PATHCONV: "1" }, stdout: "inherit", stderr: "inherit" })
      assert.equal(await child.exited, 0, "Compiled code-loader canaries")
    }
  }
  console.log(JSON.stringify({ mode, passed: true }))
} catch (error) {
  // Do not print arbitrary API bodies or Docker env output, which may contain credentials.
  console.error(JSON.stringify({ mode, passed: false, errorType: error instanceof Error ? error.name : "unknown", check: error instanceof assert.AssertionError ? error.message : undefined }))
  process.exitCode = 1
} finally {
  await adopter.release().catch(() => undefined)
  await supervisor.release().catch(() => undefined)
  const cleanup = await deps.exec(["docker", "compose", "-p", project, "-f", deps.composeFile, "down", "-v", "--remove-orphans"], { env: composeDownEnv(deps), timeoutMs: 120000 })
  console.log(JSON.stringify({ phase: "cleanup", project, exit: cleanup.code }))
  if (cleanup.code !== 0) process.exitCode = 1
}

function shellProof(session: string, directory: string) {
  return `import os, json, base64, subprocess, urllib.request, urllib.error, urllib.parse
session = ${JSON.stringify(session)}
directory = ${JSON.stringify(directory)}
password = os.environ.get("OPENCODE_SERVER_PASSWORD")
verifier = os.environ.get("OPENCODE_SERVER_PASSWORD_SHA256")
with open("/proc/1/environ", "rb") as source:
    proc = dict(item.split(b"=", 1) for item in source.read().split(b"\\0") if b"=" in item)
def request(method, route, credential, body=None, host="127.0.0.1"):
    headers = {"Content-Type": "application/json"}
    if credential:
        headers["Authorization"] = "Basic " + base64.b64encode(("opencode:" + credential).encode()).decode()
    url = "http://" + host + ":4096" + route + "?directory=" + urllib.parse.quote(directory)
    req = urllib.request.Request(url, method=method, headers=headers, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            payload = response.read()
            return response.status, json.loads(payload) if payload else None
    except urllib.error.HTTPError as error:
        return error.code, None
status, other = request("GET", "/session/" + session, password or verifier)
denials = []
memory = False
gate = None
if not password:
    gate, _ = request("GET", "/session/" + session, None, host="gate-box")
    probe = subprocess.run(["/usr/bin/python3", "-I", "-S", "/usr/local/lib/ocd-memory-probe.py", "--check", "1"], capture_output=True, timeout=15)
    memory = probe.returncode == 0 and json.loads(probe.stdout).get("ok") is True
    for name, method, route, body in [
        ("session-read", "GET", "/session/" + session, None),
        ("session-update", "PATCH", "/session/" + session, {"title":"unauthorized"}),
        ("session-prompt", "POST", "/session/" + session + "/message", {"parts":[{"type":"text","text":"unauthorized"}]}),
        ("permission-reply", "POST", "/permission/per_00000000000000000000000000/reply", {"reply":"once"}),
        ("pty-ticket", "POST", "/pty/pty_00000000000000000000000000/connect-token", {})
    ]:
        code, _ = request(method, route, verifier, body)
        denials.append({"name":name,"status":code})
print("OCD_PROOF=" + json.dumps({"envPassword":password is not None,"procPassword":b"OPENCODE_SERVER_PASSWORD" in proc,"verifierPresent":verifier is not None,"otherSessionStatus":status,"otherSessionMatched":isinstance(other,dict) and other.get("id")==session,"denials":denials,"gateStatus":gate,"memoryGuardPassed":memory},separators=(",",":")))`
}
