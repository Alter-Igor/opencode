import { createHash } from "node:crypto"
import type { Exec } from "../src/supervisor/docker.ts"
import { FRONT_GENERATIONS, FRONT_GENERATION_URL } from "../src/supervisor/front-generation.ts"

/** A worker's marker and its immutable files. Missing or changed files are never attested. */
export function generationExec(servers: string, auth: string, marker?: string): Exec {
  const hashes = [servers, auth].map((text) => createHash("sha256").update(text).digest("hex"))
  const dir = `${FRONT_GENERATIONS}/${hashes.join("-")}`
  return async (argv) => {
    if (argv.includes(FRONT_GENERATION_URL)) return { code: 0, stdout: marker ?? `${"1".repeat(32)} ${hashes.join(" ")}`, stderr: "" }
    if (argv.at(-1) === `${dir}/source-servers.conf`) return { code: 0, stdout: servers, stderr: "" }
    if (argv.at(-1) === `${dir}/synapse-auth.conf`) return { code: 0, stdout: auth, stderr: "" }
    return { code: 1, stdout: "", stderr: "unavailable" }
  }
}
