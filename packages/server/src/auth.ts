export * as ServerAuth from "./auth"

import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"
import { ServerVerifier } from "./auth-verifier"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
  readonly passwordSHA256?: string
}

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Info) {
    return Layer.sync(this, () => {
      ServerVerifier.validate({ password: Option.getOrUndefined(input.password), passwordSHA256: input.passwordSHA256 })
      return this.of(input)
    })
  }

  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const config = yield* EffectConfig.all({
          password: EffectConfig.string("OPENCODE_SERVER_PASSWORD").pipe(EffectConfig.option),
          username: EffectConfig.string("OPENCODE_SERVER_USERNAME").pipe(EffectConfig.withDefault("opencode")),
          passwordSHA256: EffectConfig.string("OPENCODE_SERVER_PASSWORD_SHA256").pipe(
            EffectConfig.option,
            EffectConfig.map(Option.getOrUndefined),
          ),
        })
        ServerVerifier.validate({
          password: Option.getOrUndefined(config.password),
          passwordSHA256: config.passwordSHA256,
        })
        return Config.of(config)
      }),
    )
  }
}

export function required(config: Info) {
  return config.passwordSHA256 !== undefined || (Option.isSome(config.password) && config.password.value !== "")
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  if (config.passwordSHA256 !== undefined)
    return (
      credentials.username === config.username &&
      ServerVerifier.authorized(Redacted.value(credentials.password), config.passwordSHA256)
    )
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

export function header(credentials?: Credentials) {
  const password =
    credentials?.password ??
    ServerVerifier.internalPassword({
      password: process.env.OPENCODE_SERVER_PASSWORD,
      passwordSHA256: process.env.OPENCODE_SERVER_PASSWORD_SHA256,
    }) ??
    process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined

  return `Basic ${Buffer.from(`${credentials?.username ?? process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
