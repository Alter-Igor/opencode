// #118: lockdown.ts runs only before the agent starts. Conntrack begins when the egress table
// loads and picks older flows up mid-stream, in either direction, so a connection the agent opened
// earlier could survive the lockdown. Refusing to run once an agent process exists closes that gap.
import { readFileSync, readdirSync, statSync } from "fs"
import path from "path"

/** PIDs of live processes owned by `uid`, read from /proc. Zombies are skipped: they hold no sockets. */
export function pidsOwnedBy(uid: number, procDir = "/proc"): number[] {
  const pids: number[] = []
  for (const name of readdirSync(procDir)) {
    if (!/^\d+$/.test(name)) continue
    try {
      if (statSync(path.join(procDir, name)).uid !== uid) continue
      if (isZombie(path.join(procDir, name, "stat"))) continue
      pids.push(Number(name))
    } catch {
      // the process ended while we looked
    }
  }
  return pids
}

/** /proc/<pid>/stat is "pid (comm) state ..."; comm may hold spaces, so read after the last ")". */
function isZombie(statFile: string): boolean {
  try {
    const text = readFileSync(statFile, "utf8")
    return text.slice(text.lastIndexOf(")") + 1).trim().startsWith("Z")
  } catch {
    return false
  }
}
