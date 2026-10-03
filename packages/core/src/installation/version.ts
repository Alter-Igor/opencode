import { existsSync, readFileSync, statSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"

declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

// Fork-only (#87): a source run (opencodealt) builds its label from the package version and
// the checkout's commit, plus when that commit landed in this checkout (from the reflog). It
// reads the git files directly, so startup spawns nothing. A compiled build shows the version
// it was built with.
export function sourceVersion(root = fileURLToPath(new URL("../../../..", import.meta.url))) {
  const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim() : undefined)
  const version = JSON.parse(read(path.join(root, "packages", "core", "package.json")) ?? "{}").version
  const dotgit = path.join(root, ".git")
  // A git worktree has a `.git` file that points at its own git folder.
  const gitDir = statSync(dotgit, { throwIfNoEntry: false })?.isFile()
    ? path.resolve(root, (read(dotgit) ?? "").replace(/^gitdir:\s*/, ""))
    : dotgit
  const head = read(path.join(gitDir, "HEAD"))
  const common = path.resolve(gitDir, read(path.join(gitDir, "commondir")) ?? ".")
  const ref = head?.startsWith("ref: ") ? head.slice(5) : undefined
  const refFile = ref ? [gitDir, common].map((dir) => path.join(dir, ref)).find((file) => existsSync(file)) : undefined
  const sha = !ref
    ? head
    : refFile
      ? read(refFile)
      : read(path.join(common, "packed-refs"))
          ?.split("\n")
          .find((line) => line.endsWith(` ${ref}`))
          ?.split(" ")[0]
  // The reflog's last line records when this ref (or a detached HEAD) moved to its commit.
  // File times are not used: packed-refs changes whenever git packs any ref.
  const entry = [gitDir, common]
    .map((dir) => read(path.join(dir, "logs", ref ?? "HEAD")))
    .find((log) => log !== undefined)
    ?.split("\n")
    .at(-1)
    ?.match(/^[0-9a-f]{40} ([0-9a-f]{40}) .*> (\d+) [+-]\d{4}\t/)
  const label = `${version ?? "local"}-alt`
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return label
  if (!entry || entry[1] !== sha) return `${label} [${sha.slice(0, 10)}]`
  const landed = new Date(Number(entry[2]) * 1000)
  const pad = (value: number) => String(value).padStart(2, "0")
  const time = `${landed.getFullYear()}-${pad(landed.getMonth() + 1)}-${pad(landed.getDate())} ${pad(landed.getHours())}:${pad(landed.getMinutes())}`
  return `${label} [${sha.slice(0, 10)} ${time}]`
}

export const InstallationVersion =
  typeof OPENCODE_VERSION === "string" && OPENCODE_VERSION !== "local" ? OPENCODE_VERSION : sourceVersion()
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "alterspective"
export const InstallationLocal = InstallationChannel === "local"
