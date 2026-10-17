// Fork (#24): `{env:VAR}` in config resolves from the environment of the process that reads the
// config. `opencode serve` started detached (Start-Process, a service, a scheduled task) can lack a
// variable the interactive shell has, so a provider key silently became "" and the vision proxy
// failed with an empty key. Config loading now names each such variable in one warning.

const ENV_TOKEN = /\{env:([^}]+)\}/g

/**
 * The `{env:VAR}` names in `text` that resolve to empty, the same way `ConfigVariable.substitute`
 * reads them (`env` first, then `process.env`). A reference on a `//` comment line is not counted,
 * and each name is listed once, in order of first use.
 */
export function unsetEnvReferences(text: string, env?: Record<string, string>): string[] {
  const names: string[] = []
  for (const match of text.matchAll(ENV_TOKEN)) {
    const name = match[1]
    if (names.includes(name)) continue
    const lineStart = text.lastIndexOf("\n", (match.index ?? 0) - 1) + 1
    if (text.slice(lineStart, match.index).trimStart().startsWith("//")) continue
    if (!(env?.[name] ?? process.env[name])) names.push(name)
  }
  return names
}

export * as ConfigUnsetEnv from "./unset-env"
