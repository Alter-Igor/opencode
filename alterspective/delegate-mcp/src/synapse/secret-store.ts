// WS2 (#48): where the owner's Synapse refresh token lives on the host. Never in the box, never in a
// log, never in the bridge's JSON state.
//
// Choice: a DPAPI-encrypted file (<home>/synapse/refresh.dpapi), CurrentUser scope, with a fixed
// entropy string. Why not @napi-rs/keyring: a native module under Bun on Windows adds a build and
// load risk to every bridge start for one secret; Windows PowerShell 5.1 (always present) gives the
// same user-bound protection through System.Security.Cryptography.ProtectedData with no
// dependency. Only the same Windows user on the same machine can decrypt it; the file sits under
// the user's profile. The secret crosses to PowerShell on stdin only (never argv, never env).
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

export type SecretStore = {
  /** The stored secret, or undefined when none is stored. Throws when it exists but cannot be read. */
  read(): Promise<string | undefined>
  write(value: string): Promise<void>
  remove(): Promise<void>
  /** Whether a secret is stored (no decryption). */
  has(): Promise<boolean>
  readonly kind: string
}

const ENTROPY = "opencode-delegate/synapse-refresh/v1"
const PS_TIMEOUT_MS = 30_000
const PROTECT = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$i=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($i);$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}');[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser')))`
const UNPROTECT = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$i=[Console]::In.ReadToEnd().Trim();$e=[Text.Encoding]::UTF8.GetBytes('${ENTROPY}');[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($i),$e,'CurrentUser')))`

export const refreshStoreFile = (home: string) => path.join(home, "synapse", "refresh.dpapi")

/** Runs a fixed PowerShell script with `input` on stdin. Returns stdout, or throws without echoing it. */
export type PowerShell = (script: string, input: string) => Promise<string>

export const windowsPowerShell: PowerShell = async (script, input) => {
  const exe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const child = Bun.spawn([exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true })
  child.stdin.write(input)
  await child.stdin.end()
  const timer = setTimeout(() => child.kill(), PS_TIMEOUT_MS)
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  clearTimeout(timer)
  // stderr is not read into the message: a failing script may echo its input.
  if (code !== 0) throw new Error(`DPAPI call failed (exit ${code})`)
  return out
}

/** DPAPI-backed store (Windows only; elsewhere every call fails closed). */
export function dpapiStore(file: string, ps: PowerShell = windowsPowerShell, platform = process.platform): SecretStore {
  const windowsOnly = () => {
    if (platform !== "win32") throw new Error("the Synapse refresh token store needs Windows DPAPI")
  }
  return {
    kind: "dpapi-file",
    async read() {
      const cipher = await readFile(file, "utf8").catch(() => undefined)
      if (cipher === undefined) return undefined
      windowsOnly()
      const plain = await ps(UNPROTECT, cipher)
      return plain === "" ? undefined : plain
    },
    async write(value) {
      windowsOnly()
      const cipher = await ps(PROTECT, value)
      if (!/^[A-Za-z0-9+/=]+$/.test(cipher)) throw new Error("DPAPI returned an unexpected value")
      await mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, cipher, { encoding: "utf8", mode: 0o600 })
      await rename(tmp, file)
    },
    remove: () => rm(file, { force: true }),
    has: async () => (await stat(file).catch(() => undefined))?.isFile() === true,
  }
}

/** Tests: an in-memory store with the same contract. */
export function memoryStore(initial?: string): SecretStore & { value: string | undefined } {
  const store = {
    kind: "memory",
    value: initial,
    read: async () => store.value,
    write: async (value: string) => void (store.value = value),
    remove: async () => void (store.value = undefined),
    has: async () => store.value !== undefined,
  }
  return store
}
