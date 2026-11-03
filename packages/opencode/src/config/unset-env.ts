// Fork (#24): `{env:VAR}` in config resolves from the environment of the process that reads the
// config. `opencode serve` started detached (Start-Process, a service, a scheduled task) can lack a
// variable the interactive shell has, so a provider key silently became "" and the vision proxy
// failed with an empty key. Config loading now names each such variable in one warning.

const ENV_TOKEN = /\{env:([^}]+)\}/g

/**
 * Strip `//` line comments and `/* ... *\/` block comments from JSONC text while preserving string
 * literals (`"..."`, including escaped quotes `\"`) so URLs or comment-like text inside strings are
 * left intact and commented-out `{env:VAR}` tokens are removed.
 */
export function stripJsonComments(text: string): string {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1]
        i += 1
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      i += 2
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i += 1
      if (i < text.length) out += text[i]
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n" || text[i] === "\r") out += text[i]
        i += 1
      }
      if (i < text.length) i += 1
      continue
    }
    out += ch
  }
  return out
}

/**
 * The `{env:VAR}` names in `text` that resolve to empty, the same way `ConfigVariable.substitute`
 * reads them (`env` first, then `process.env`). References inside `//` or `/* ... *\/` JSONC
 * comments are ignored, and each name is listed once, in order of first use.
 */
export function unsetEnvReferences(text: string, env?: Record<string, string>): string[] {
  const names: string[] = []
  const stripped = stripJsonComments(text)
  for (const match of stripped.matchAll(ENV_TOKEN)) {
    const name = match[1]
    if (names.includes(name)) continue
    if (!(env?.[name] ?? process.env[name])) names.push(name)
  }
  return names
}

export * as ConfigUnsetEnv from "./unset-env"
