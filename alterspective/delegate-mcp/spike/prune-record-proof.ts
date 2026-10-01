// Run through the workstation work queue. Uses only a fresh, networkless container's tmpfs.
import { ABSENT_CLONE_PROBE } from "../src/supervisor/workspaces-prune.ts"

const image = "opencode-delegate-box:1.18.31-bc1a3343c278-front"
const script = `set -eu
mkdir -p /tmp/sessions/kept /tmp/sessions/private
ln -s /tmp/does-not-exist /tmp/sessions/dangling
chmod 000 /tmp/sessions/private
probe() {
  set +e
  sh -c '${ABSENT_CLONE_PROBE}' sh "$1" "$2"
  result=$?
  set -e
  [ "$result" = "$3" ]
}
probe /tmp/sessions/absent /tmp/sessions 44
probe /tmp/sessions/kept /tmp/sessions 45
probe /tmp/sessions/dangling /tmp/sessions 45
probe /tmp/missing/absent /tmp/missing 46
probe /tmp/sessions/private/hidden /tmp/sessions/private 46
printf '{"absent":true,"directoryKept":true,"danglingLinkKept":true,"missingParentKept":true,"unreadableParentKept":true}\\n'
`
const child = Bun.spawn(["docker", "run", "-i", "--rm", "--network", "none", "--read-only", "--user", "101:101", "--tmpfs", "/tmp:rw,noexec,nosuid,size=8m,mode=1777", "--entrypoint", "sh", image, "-s"], { stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe", env: { ...process.env, MSYS_NO_PATHCONV: "1" } })
const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
if (code !== 0) throw new Error(`prune proof failed (${code}): ${stderr}`)
const result = JSON.parse(stdout.trim())
for (const key of ["absent", "directoryKept", "danglingLinkKept", "missingParentKept", "unreadableParentKept"]) {
  if (result[key] !== true) throw new Error(`missing proof: ${key}`)
}
console.log(JSON.stringify(result))
