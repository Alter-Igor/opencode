// Isolated #49 kernel proof. No network, no real credentials, no shared containers.
import path from "node:path"
import { bunExec } from "../src/supervisor/docker.ts"

const file = path.resolve(import.meta.dir, "../docker/box/memory-probe.py")
const baseline = [
  "docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--user", "agent",
  "--mount", `type=bind,source=${file},target=/probe.py,readonly`,
  ...["OPENCODE_SERVER_PASSWORD_SHA256=" + "0".repeat(64), ...["REMOTE_CONFIG", "EXTERNAL_PROVIDERS", "PROJECT_CONFIG", "EXTERNAL_SKILLS", "CLAUDE_CODE"].map((name) => `OPENCODE_DISABLE_${name}=1`)].flatMap((value) => ["-e", value]),
]
for (const [name, extra, pass] of [
  ["safe", ["--ulimit", "core=0:0"], true],
  ["core-enabled", ["--ulimit", "core=1:1"], false],
  ["debug-env", ["--ulimit", "core=0:0", "-e", "BUN_INSPECT=1"], false],
  ["plaintext-env", ["--ulimit", "core=0:0", "-e", "OPENCODE_SERVER_PASSWORD=sentinel-no-live-secret"], false],
] as const) {
  const result = await bunExec([...baseline, ...extra, "--entrypoint", "/bin/sh", "opencode-delegate-box:1.18.31-bc1a3343c278", "-c", "/usr/bin/python3 -I -S /probe.py --startup; result=$?; exit $result"], { timeoutMs: 30_000 })
  const report: unknown = JSON.parse(result.stdout)
  console.log(JSON.stringify({ case: name, exit: result.code, report }))
  if (result.code !== (pass ? 0 : 1) || !report || typeof report !== "object" || !("ok" in report) || report.ok !== pass) throw new Error(`unexpected guard result for ${name}`)
}
