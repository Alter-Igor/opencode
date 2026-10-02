// #67 step 1: where the host keeps each Keystone connection's refresh token. Same choice and reasons
// as the Synapse store (synapse/secret-store.ts): a DPAPI-encrypted file, CurrentUser scope, the
// secret crossing to Windows PowerShell on stdin only. Never in the box, a log, or the state file.
//
// The entropy is Keystone-only AND names the connection, so a Synapse ciphertext, or another
// connection's file copied over this one, does not decrypt here: each file opens for one purpose.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { renameWithRetry } from "../synapse/fs-retry.ts"
import { attempt } from "./attempt.ts"
import { windowsPowerShell, type PowerShell, type SecretStore } from "../synapse/secret-store.ts"
import { assertConnectionId, keystoneDir } from "./state.ts"

const PS_PREFIX = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;"

/** DPAPI optional entropy for one connection's refresh token (purpose string, not a secret). */
export const keystoneEntropy = (connectionId: string) => `opencode-delegate/keystone-refresh/v1/${assertConnectionId(connectionId)}`

/** <home>/keystone/<id>.refresh.dpapi */
export const keystoneStoreFile = (home: string, connectionId: string) => path.join(keystoneDir(home), `${assertConnectionId(connectionId)}.refresh.dpapi`)

function scripts(entropy: string) {
  // The entropy is a fixed slug-only string (assertConnectionId), so it is safe inside single quotes.
  const e = `$e=[Text.Encoding]::UTF8.GetBytes('${entropy}');`
  return {
    protect: `${PS_PREFIX}$i=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($i);${e}[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser')))`,
    unprotect: `${PS_PREFIX}$i=[Console]::In.ReadToEnd().Trim();${e}[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($i),$e,'CurrentUser')))`,
  }
}

/**
 * The DPAPI-backed refresh-token store of one Keystone connection (Windows only; elsewhere every
 * read of an existing file and every write fails closed, so no token is ever kept in plain text).
 *
 * @param home bridge home
 * @param connectionId Keystone connection id (lower-case slug)
 * @param ps runs a fixed PowerShell script with the secret on stdin (injectable for tests)
 * @param platform process.platform (injectable for tests)
 * @returns a SecretStore with the same contract as the Synapse store
 * @throws when `connectionId` is not a valid slug
 * @example const store = keystoneDpapiStore(home, "rag-read")
 */
export function keystoneDpapiStore(home: string, connectionId: string, ps: PowerShell = windowsPowerShell, platform = process.platform): SecretStore {
  const file = keystoneStoreFile(home, connectionId)
  const { protect, unprotect } = scripts(keystoneEntropy(connectionId))
  const windowsOnly = () => {
    if (platform !== "win32") throw new Error("the Keystone refresh token store needs Windows DPAPI")
  }
  return {
    kind: "dpapi-file",
    async read() {
      const read = await attempt(() => readFile(file, "utf8"))
      if (!read.ok) {
        // Missing is "nothing stored"; any other read error must not look like a sign-out.
        if (read.error instanceof Error && "code" in read.error && read.error.code === "ENOENT") return undefined
        throw read.error
      }
      const cipher = read.value
      windowsOnly()
      const plain = await ps(unprotect, cipher)
      return plain === "" ? undefined : plain
    },
    async write(value) {
      windowsOnly()
      const cipher = await ps(protect, value)
      if (!/^[A-Za-z0-9+/=]+$/.test(cipher)) throw new Error("DPAPI returned an unexpected value")
      await mkdir(path.dirname(file), { recursive: true })
      // Every write happens under the shared lock, so one tmp name per process is enough.
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, cipher, { encoding: "utf8", mode: 0o600 })
      await renameWithRetry(tmp, file)
    },
    remove: () => rm(file, { force: true }),
    has: async () => {
      const info = await attempt(() => stat(file))
      return info.ok && info.value.isFile()
    },
  }
}
