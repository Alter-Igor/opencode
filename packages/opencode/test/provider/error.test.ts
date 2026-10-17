import { describe, expect, test } from "bun:test"
import { ProviderError } from "@/provider/error"

describe("provider stream errors", () => {
  test("retries provider stream errors without a code", () => {
    const messages = [
      "The model is currently at capacity due to high demand. Please try again in a few minutes, or use a higher service tier for priority processing: https://docs.x.ai/developers/advanced-api-usage/priority-processing",
      "The model is temporarily unavailable.",
    ]

    for (const message of messages)
      expect(
        ProviderError.parseStreamError({
          type: "error",
          error: { message },
        }),
      ).toEqual({
        type: "api_error",
        message,
        isRetryable: true,
        responseBody: JSON.stringify({ type: "error", error: { message } }),
      })
  })

  test("classifies the Synapse context_overflow code or reason in a stream error (#196)", () => {
    for (const error of [{ code: "context_overflow" }, { reason: "context_overflow" }]) {
      const body = { type: "error", error: { ...error, message: "Request rejected" } }
      expect(ProviderError.parseStreamError(body)).toEqual({
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody: JSON.stringify(body),
      })
    }
  })
})
