// MOD-01 T1.1: secret scan of owner provider entries before they are copied into the box
// profile (review A-03). It FAILS CLOSED: a value is refused unless it is provably not a secret.
//  - Under any `headers` object, and under any secret-named key, every string must be an
//    {env:NAME} reference (optionally after a scheme word such as "Bearer "), and numbers are
//    refused. Booleans and null are allowed (they cannot carry a secret).
//  - Everywhere: {file:...} is refused, URLs with user:password@ are refused, and strings that
//    look like known token formats are refused.
// Values never appear in errors; only the key path is named (ERR-MSG-03, ASR-04).
import { DelegateError } from "../shared/errors.ts"

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

export const SECRET_KEY =
  /key$|keyid$|access[-_]?key|api[-_]?key|auth|subscription|token|secret|passw(or)?d|passphrase|credential|bearer|cookie|signature|private/i
/** Counts such as maxTokens / max_output_tokens / budgetTokens may be numbers. */
const TOKEN_COUNT = /tokens$/i
const SECRET_VALUE = [
  /(^|[^A-Za-z0-9])(sk|pk|rk|gpapp|ghp|gho|ghs|ghu|ghr|glpat|xox[abprs])[-_][A-Za-z0-9]{6,}/i,
  /github_pat_/i,
  /AIza[0-9A-Za-z_-]{20,}/,
  /(AKIA|ASIA)[0-9A-Z]{12,}/,
  /eyJ[A-Za-z0-9_-]{8,}/,
  /^(bearer|basic|token)\s+\S/i,
  /AccountKey=|SharedAccessSignature=/i,
  /[?&](sig|key|api[-_]?key|token|access_token|code|password)=[^&#\s]/i,
]
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i
const ENV_REF = /\{env:([^}]*)\}/g
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** A strict slot holds "{env:NAME}", or a scheme word followed by one. */
const STRICT_SHAPE = /^((bearer|basic|token)\s+)?\{env:[A-Za-z_][A-Za-z0-9_]*\}$/i

export type Scan = { envNames: Set<string> }
type Mode = { strict: boolean; parentKey: string | undefined }

/** Walk a provider entry; refuse anything that could be a literal secret, collect {env:} names. */
export function scanProvider(value: Json, keyPath: string, scan: Scan = { envNames: new Set() }, mode: Mode = { strict: false, parentKey: undefined }): Scan {
  if (typeof value === "string") checkString(value, keyPath, scan, mode.strict)
  else if (typeof value === "number") {
    if (mode.strict && !TOKEN_COUNT.test(lastKey(keyPath))) throw invalid(`The owner config has a non-text value in a secret field at ${keyPath}. Use {env:NAME}.`)
  } else if (Array.isArray(value)) value.forEach((item, index) => scanProvider(item, `${keyPath}[${index}]`, scan, mode))
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      scanProvider(child, `${keyPath}.${key}`, scan, { strict: mode.strict || isStrictKey(key, mode.parentKey, child), parentKey: key })
    }
  }
  return scan
}

/** Model ids under `models` are names, not settings, so they are not matched against SECRET_KEY. */
function isStrictKey(key: string, parentKey: string | undefined, child: Json): boolean {
  if (key.toLowerCase() === "headers") return true
  if (parentKey === "models") return false
  if (TOKEN_COUNT.test(key) && typeof child === "number") return false
  return SECRET_KEY.test(key)
}

function lastKey(keyPath: string): string {
  return keyPath.slice(keyPath.lastIndexOf(".") + 1)
}

function checkString(value: string, keyPath: string, scan: Scan, strict: boolean) {
  if (value.includes("{file:"))
    throw invalid(`The owner config uses a {file:...} reference at ${keyPath}; the box cannot read host files. Use {env:NAME}.`)
  for (const match of value.matchAll(ENV_REF)) {
    const name = match[1]!
    if (!ENV_NAME.test(name)) throw invalid(`The owner config has an invalid {env:...} name at ${keyPath}.`)
    scan.envNames.add(name)
  }
  if (URL_USERINFO.test(value)) throw invalid(`The owner config has a URL with a user name or password at ${keyPath}. Use headers with {env:NAME}.`)
  const literal = value.replace(ENV_REF, "")
  if (SECRET_VALUE.some((pattern) => pattern.test(literal.trim())))
    throw invalid(`The owner config has what looks like a literal secret at ${keyPath}. Use {env:NAME}.`)
  if (strict && value !== "" && !STRICT_SHAPE.test(value.trim()))
    throw invalid(`The owner config has a literal value in a secret or header field at ${keyPath}. Replace it with {env:NAME}.`)
}

export function invalid(message: string, detail?: string): DelegateError {
  return new DelegateError("profile_invalid", message, "Fix the owner's OpenCode config (~/.config/opencode) and retry.", detail)
}
