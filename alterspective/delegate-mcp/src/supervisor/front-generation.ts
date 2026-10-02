// Only a response from an nginx worker proves a generation is loaded. nginx -T reads disk.
// The loopback listener is inside front, never published or reachable from the box.
//
// The worker replies `<nonce> <servers sha> <auth sha>`. #67 step 3: when servers.conf includes
// per-connection Keystone files (OCD_KEYSTONE_HOST_AUTH), front-reload adds a fourth field, the
// sha256 of the generation's ks-auth.list (one `ks-auth-<id>.conf <sha256>` line per include,
// sorted by id). Without Keystone includes the reply keeps its three fields.
import { createHash } from "node:crypto"
import { CONNECTION_ID } from "../shared/keystone.ts"
import { KS_AUTH_VAR, authConfHasToken, isAuthConf } from "../synapse/auth-conf.ts"
import type { Exec } from "./docker.ts"

export const FRONT_GENERATION_URL = "http://127.0.0.1:19091/__ocd_generation"
export const FRONT_GENERATIONS = "/tmp/front/generations"
/** The list front-reload writes into a generation that has Keystone includes. */
export const KS_AUTH_LIST = "ks-auth.list"
/**
 * One loaded Keystone include, as states only (like the Synapse live check): `shape` is the strict
 * $ks_auth file, `token` that it carries a bearer token. The file text (the token) is never returned.
 */
export type FrontKeystoneAuth = { id: string; shape: boolean; token: boolean }
/** `keystone` is present only when the loaded generation has Keystone includes. */
export type FrontGeneration = { servers: string; auth: string; keystone?: FrontKeystoneAuth[] }

const MARKER = /^[0-9a-f]{32} ([0-9a-f]{64}) ([0-9a-f]{64})(?: ([0-9a-f]{64}))?$/
const LIST_LINE = /^ks-auth-([a-z0-9][a-z0-9-]{0,62})\.conf ([0-9a-f]{64})$/

export async function readFrontGeneration(exec: Exec, container: string): Promise<FrontGeneration | undefined> {
  const response = await exec(["docker", "exec", container, "wget", "-q", "-T", "2", "-O", "-", FRONT_GENERATION_URL], { timeoutMs: 5_000 })
  const hashes = MARKER.exec(response.stdout.trim())
  if (response.code !== 0 || !hashes) return undefined
  const [, serversSha, authSha, listSha] = hashes
  const dir = `${FRONT_GENERATIONS}/${[serversSha, authSha, listSha].filter((h) => h !== undefined).join("-")}`
  const cat = (name: string) => exec(["docker", "exec", container, "cat", `${dir}/${name}`], { timeoutMs: 5_000 })
  const [servers, auth] = await Promise.all([cat("source-servers.conf"), cat("synapse-auth.conf")])
  if (servers.code !== 0 || auth.code !== 0) return undefined
  if (sha(servers.stdout) !== serversSha || sha(auth.stdout) !== authSha) return undefined
  if (listSha === undefined) return { servers: servers.stdout, auth: auth.stdout }
  const keystone = await readKeystone(cat, listSha)
  return keystone === undefined ? undefined : { servers: servers.stdout, auth: auth.stdout, keystone }
}

type Cat = (name: string) => Promise<{ code: number; stdout: string }>

/** The list, verified against the reply, then each include it names, verified against the list. Any doubt: undefined. */
async function readKeystone(cat: Cat, listSha: string): Promise<FrontKeystoneAuth[] | undefined> {
  const list = await cat(KS_AUTH_LIST)
  if (list.code !== 0 || sha(list.stdout) !== listSha || !list.stdout.endsWith("\n")) return undefined
  const entries: { id: string; sha: string }[] = []
  for (const line of list.stdout.slice(0, -1).split("\n")) {
    const match = LIST_LINE.exec(line)
    if (!match || !CONNECTION_ID.test(match[1]!) || entries.some((e) => e.id === match[1])) return undefined
    entries.push({ id: match[1]!, sha: match[2]! })
  }
  const files = await Promise.all(entries.map((entry) => cat(`ks-auth-${entry.id}.conf`)))
  const out: FrontKeystoneAuth[] = []
  for (const [index, entry] of entries.entries()) {
    const file = files[index]!
    if (file.code !== 0 || sha(file.stdout) !== entry.sha) return undefined
    out.push({ id: entry.id, shape: isAuthConf(file.stdout, KS_AUTH_VAR), token: authConfHasToken(file.stdout, KS_AUTH_VAR) })
  }
  return out
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
