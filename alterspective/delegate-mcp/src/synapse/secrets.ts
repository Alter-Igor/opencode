// WS2 (#48): the two app credentials the host bridge needs for the owner's Synapse token.
// - broker key (Keystone service credential of app `opencode`, scope credentials:broker): the exchange.
// - client secret of app `opencode`: the refresh.
// Read once per bridge, env override first (same names as the fork plugin), else the vault through
// the Azure CLI. Kept in memory only: never written to disk, never logged, never put in the box.
import path from "node:path"
import { runProcess } from "../supervisor/spawn.ts"
import { childEnv } from "../supervisor/docker.ts"

export const BROKER_KEY_ENV = "OPENCODE_KEYSTONE_BROKER_KEY"
export const CLIENT_SECRET_ENV = "OPENCODE_KEYSTONE_CLIENT_SECRET"
export const VAULT_NAME = "alterspective-vault"
export const VAULT_SECRETS = { brokerKey: "opencode-keystone-broker-key", clientSecret: "opencode-keystone-client-secret" } as const

export type AppSecrets = { brokerKey: string; clientSecret: string }
export type SecretSource = "env" | "vault"
export type LoadedSecrets = { secrets: AppSecrets; source: Record<keyof AppSecrets, SecretSource> }
/** Reads one vault secret value (trimmed), or undefined. Never logs. */
export type VaultReader = (name: string) => Promise<string | undefined>

const AZ_TIMEOUT_MS = 60_000
/** az's own config lives here; it is not a secret. */
const AZ_ENV = ["AZURE_CONFIG_DIR", "AZURE_CORE_OUTPUT"]

export const azVaultReader: VaultReader = async (name) => {
  const argv = ["keyvault", "secret", "show", "--vault-name", VAULT_NAME, "--name", name, "--query", "value", "-o", "tsv"]
  // az on Windows is az.cmd, which spawn() cannot start without a shell; cmd /d /c runs it with fixed arguments.
  const command = process.platform === "win32" ? [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), "/d", "/c", "az", ...argv] : ["az", ...argv]
  const extra = Object.fromEntries(AZ_ENV.flatMap((key) => (process.env[key] ? [[key, process.env[key] as string]] : [])))
  const result = await runProcess(command, { env: childEnv(process.env, extra), timeoutMs: AZ_TIMEOUT_MS })
  const value = result.stdout.trim()
  return result.code === 0 && value !== "" && !/\s/.test(value) ? value : undefined
}

/** Env first, then the vault. Throws a message that names the secret, never its value. */
export async function loadAppSecrets(env: NodeJS.ProcessEnv, vault: VaultReader = azVaultReader): Promise<LoadedSecrets> {
  const pick = async (envName: string, vaultName: string): Promise<[string, SecretSource]> => {
    const fromEnv = env[envName]?.trim()
    if (fromEnv) return [fromEnv, "env"]
    const fromVault = await vault(vaultName)
    if (fromVault) return [fromVault, "vault"]
    throw new Error(`${vaultName} is not available: set ${envName}, or sign in with \`az login\` to an account that can read ${VAULT_NAME}`)
  }
  const [brokerKey, clientSecret] = await Promise.all([pick(BROKER_KEY_ENV, VAULT_SECRETS.brokerKey), pick(CLIENT_SECRET_ENV, VAULT_SECRETS.clientSecret)])
  return { secrets: { brokerKey: brokerKey[0], clientSecret: clientSecret[0] }, source: { brokerKey: brokerKey[1], clientSecret: clientSecret[1] } }
}
