export * as ServerVerifier from "./auth-verifier"

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

type Input = { password?: string; passwordSHA256?: string }

// Trusted in-process clients share this credential. Never copy it into env, files or child args.
const internal = randomBytes(32).toString("base64url")
const internalDigest = createHash("sha256").update(internal).digest()

export function validate(input: Input) {
  if (input.passwordSHA256 === undefined) return
  if (!/^[a-f0-9]{64}$/.test(input.passwordSHA256))
    throw new Error("OPENCODE_SERVER_PASSWORD_SHA256 must be a 64-character lowercase SHA-256 digest")
  if (input.password !== undefined)
    throw new Error("OPENCODE_SERVER_PASSWORD and OPENCODE_SERVER_PASSWORD_SHA256 cannot both be set")
}

export function internalPassword(input: Input) {
  validate(input)
  return input.passwordSHA256 === undefined ? undefined : internal
}

export function authorized(password: string, digest: string) {
  validate({ passwordSHA256: digest })
  const candidate = createHash("sha256").update(password).digest()
  return timingSafeEqual(candidate, Buffer.from(digest, "hex")) || timingSafeEqual(candidate, internalDigest)
}
