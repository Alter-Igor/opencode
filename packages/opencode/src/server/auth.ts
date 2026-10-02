export * as ServerAuth from "./auth"

import { Flag } from "@opencode-ai/core/flag/flag"
import { ServerVerifier } from "@opencode-ai/server/auth-verifier"
import type { Credentials } from "@opencode-ai/server/auth"

export { Config, required, authorized } from "@opencode-ai/server/auth"
export type { Credentials, DecodedCredentials, Info } from "@opencode-ai/server/auth"

export function header(credentials?: Credentials) {
  const password =
    credentials?.password ??
    ServerVerifier.internalPassword({
      password: Flag.OPENCODE_SERVER_PASSWORD,
      passwordSHA256: process.env.OPENCODE_SERVER_PASSWORD_SHA256,
    }) ??
    Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined

  const username = credentials?.username ?? Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
