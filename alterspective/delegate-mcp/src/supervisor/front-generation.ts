// Only a response from an nginx worker proves a generation is loaded. nginx -T reads disk.
// The loopback listener is inside front, never published or reachable from the box.
import { createHash } from "node:crypto"
import type { Exec } from "./docker.ts"

export const FRONT_GENERATION_URL = "http://127.0.0.1:19091/__ocd_generation"
export const FRONT_GENERATIONS = "/tmp/front/generations"
export type FrontGeneration = { servers: string; auth: string }

export async function readFrontGeneration(exec: Exec, container: string): Promise<FrontGeneration | undefined> {
  const response = await exec(["docker", "exec", container, "wget", "-q", "-T", "2", "-O", "-", FRONT_GENERATION_URL], { timeoutMs: 5_000 })
  const hashes = /^[0-9a-f]{32} ([0-9a-f]{64}) ([0-9a-f]{64})$/.exec(response.stdout.trim())
  if (response.code !== 0 || !hashes) return undefined
  const dir = `${FRONT_GENERATIONS}/${hashes[1]}-${hashes[2]}`
  const [servers, auth] = await Promise.all([
    exec(["docker", "exec", container, "cat", `${dir}/source-servers.conf`], { timeoutMs: 5_000 }),
    exec(["docker", "exec", container, "cat", `${dir}/synapse-auth.conf`], { timeoutMs: 5_000 }),
  ])
  if (servers.code !== 0 || auth.code !== 0) return undefined
  if (sha(servers.stdout) !== hashes[1] || sha(auth.stdout) !== hashes[2]) return undefined
  return { servers: servers.stdout, auth: auth.stdout }
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
