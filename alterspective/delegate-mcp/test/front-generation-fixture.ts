import { createHash } from "node:crypto"
import type { Exec } from "../src/supervisor/docker.ts"
import { FRONT_GENERATIONS, FRONT_GENERATION_URL, KS_AUTH_LIST } from "../src/supervisor/front-generation.ts"

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/** The `ks-auth.list` front-reload writes: one `ks-auth-<id>.conf <sha256>` line per include, sorted by id. */
export const ksList = (keystone: Record<string, string>) =>
  Object.keys(keystone)
    .sort()
    .map((id) => `ks-auth-${id}.conf ${sha(keystone[id]!)}\n`)
    .join("")

/**
 * A worker's marker and its immutable files. Missing or changed files are never attested.
 * With `keystone` (#67 step 3), the marker carries a fourth hash: the generation's ks-auth.list.
 */
export function generationExec(servers: string, auth: string, marker?: string, keystone?: Record<string, string>): Exec {
  const hashes = [servers, auth].map(sha)
  const list = keystone === undefined ? undefined : ksList(keystone)
  if (list !== undefined) hashes.push(sha(list))
  const dir = `${FRONT_GENERATIONS}/${hashes.join("-")}`
  return async (argv) => {
    if (argv.includes(FRONT_GENERATION_URL)) return { code: 0, stdout: marker ?? `${"1".repeat(32)} ${hashes.join(" ")}`, stderr: "" }
    if (argv.at(-1) === `${dir}/source-servers.conf`) return { code: 0, stdout: servers, stderr: "" }
    if (argv.at(-1) === `${dir}/synapse-auth.conf`) return { code: 0, stdout: auth, stderr: "" }
    if (list !== undefined && argv.at(-1) === `${dir}/${KS_AUTH_LIST}`) return { code: 0, stdout: list, stderr: "" }
    for (const [id, text] of Object.entries(keystone ?? {})) if (argv.at(-1) === `${dir}/ks-auth-${id}.conf`) return { code: 0, stdout: text, stderr: "" }
    return { code: 1, stdout: "", stderr: "unavailable" }
  }
}
