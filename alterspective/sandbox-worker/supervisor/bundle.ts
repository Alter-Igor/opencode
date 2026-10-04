// #108 (fork #57 T5): the repository bundle the box works on must be the one the service sent.
// The service puts the bundle file's SHA-256 and the expected tree of the checked-out commit in
// the manifest; the supervisor refuses to start `opencode serve` on any mismatch.
import { $ } from "bun"

export type BundleCheck = { ok: true } | { ok: false; reason: string }

const HEX64 = /^[0-9a-f]{64}$/
/** A git object id: SHA-1 (40 hex) or SHA-256 (64 hex). */
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/

/** SHA-256 of a file, streamed, as lower-case hex. */
export async function sha256File(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(file).stream()) hasher.update(chunk)
  return hasher.digest("hex")
}

/** Checks the bundle file before it is cloned. */
export async function checkBundleFile(file: string, expectedSha256: unknown): Promise<BundleCheck> {
  if (typeof expectedSha256 !== "string") return { ok: false, reason: "repo.sha256 is not a string" }
  const expected = expectedSha256.trim().toLowerCase()
  if (!HEX64.test(expected)) return { ok: false, reason: "repo.sha256 is not a 64-character hex SHA-256" }
  const actual = await sha256File(file).catch(() => undefined)
  if (actual === undefined) return { ok: false, reason: "the bundle file cannot be read" }
  if (actual !== expected) return { ok: false, reason: `bundle SHA-256 mismatch: expected ${expected}, got ${actual}` }
  return { ok: true }
}

/** Checks the tree of the commit checked out in `repoDir` after the clone. */
export async function checkTree(repoDir: string, expectedTree: unknown): Promise<BundleCheck> {
  if (typeof expectedTree !== "string") return { ok: false, reason: "repo.treeSha is not a string" }
  const expected = expectedTree.trim().toLowerCase()
  if (!OBJECT_ID.test(expected)) return { ok: false, reason: "repo.treeSha is not a git object id" }
  const actual = (await $`git -C ${repoDir} rev-parse --verify --quiet HEAD^{tree}`.nothrow().quiet().text()).trim()
  if (!actual) return { ok: false, reason: "the cloned repository has no commit to check" }
  if (actual !== expected) return { ok: false, reason: `tree mismatch: expected ${expected}, got ${actual}` }
  return { ok: true }
}
