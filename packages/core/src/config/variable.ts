export * as ConfigVariable from "./variable.js"

import os from "os"
import path from "path"
import { Effect } from "effect"
import { type ParseError, parse } from "jsonc-parser"
import { FSUtil } from "@opencode/util/fs-util"
import { unsetEnvReferences } from "./unset-env.js"

type ParseSource =
  | {
      type: "path"
      path: string
    }
  | {
      type: "virtual"
      source: string
      dir: string
    }

type SubstituteInput = ParseSource & {
  text: string
  env?: Record<string, string>
}

export function findUnsetConfigEnvVars(
  text: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return unsetEnvReferences(text, env as Record<string, string>)
}

export function warnUnsetConfigEnvVars(
  text: string,
  configPath: string,
  warn: (message: string, extra: { path: string; vars: string[] }) => void,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const unset = findUnsetConfigEnvVars(text, env)
  if (unset.length === 0) return []
  const list = unset.map((name) => `{env:${name}}`).join(", ")
  warn(
    `Config file ${configPath} references unset environment variable${unset.length === 1 ? "" : "s"} ${list}; substituting empty string`,
    { path: configPath, vars: unset },
  )
  return unset
}

/** Apply {env:VAR} and {file:path} substitutions to config text. */
export const substitute = Effect.fn("ConfigVariable.substitute")(function* (input: SubstituteInput) {
  const unset = findUnsetConfigEnvVars(input.text, input.env ?? process.env)
  if (unset.length > 0) {
    const configSource = input.type === "path" ? input.path : input.source
    const list = unset.map((name) => `{env:${name}}`).join(", ")
    yield* Effect.logWarning(
      `Config file ${configSource} references unset environment variable${unset.length === 1 ? "" : "s"} ${list}; substituting empty string`,
    )
  }
  const env = (escape: boolean) =>
    input.text.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
      const value = (input.env?.[name] ?? process.env[name]) || ""
      return escape ? JSON.stringify(value).slice(1, -1) : value
    })
  // Escape only when raw values break the JSON (e.g. Windows paths), so configs that parse today keep their meaning.
  const raw = yield* substituteFiles(input, env(false))
  const errors: ParseError[] = []
  if (input.text.includes("{env:")) parse(raw, errors, { allowTrailingComma: true })
  if (!errors.length) return raw
  return yield* substituteFiles(input, env(true))
})

const substituteFiles = Effect.fnUntraced(function* (input: SubstituteInput, text: string) {
  const fs = yield* FSUtil.Service
  const configDir = input.type === "path" ? path.dirname(input.path) : input.dir
  const configSource = input.type === "path" ? input.path : input.source
  let out = ""
  let cursor = 0

  for (const match of text.matchAll(/\{file:[^}]+\}/g)) {
    const token = match[0]
    const index = match.index
    out += text.slice(cursor, index)

    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const prefix = text.slice(lineStart, index).trimStart()
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    const filePath = token.slice("{file:".length, -1)
    const expandedPath = filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath
    const resolvedPath = path.isAbsolute(expandedPath) ? expandedPath : path.resolve(configDir, expandedPath)
    // Like a missing {env:VAR}, a missing or unreadable file substitutes empty so one stale secret
    // reference cannot take down every Location that loads this config.
    const fileContent = yield* fs.readFileString(resolvedPath).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("config file reference is missing or unreadable", {
          source: configSource,
          reference: token,
          path: resolvedPath,
          cause,
        }).pipe(Effect.as("")),
      ),
    )

    out += JSON.stringify(fileContent.trim()).slice(1, -1)
    cursor = index + token.length
  }

  return out + text.slice(cursor)
})
