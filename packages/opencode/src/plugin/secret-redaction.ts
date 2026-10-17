// Fork (#26, #207): the redaction rules moved to core (`@opencode-ai/core/util/secret-redaction`), so
// the core session projector can redact every tool part it stores. This path stays for the plugin,
// session and CLI callers.
export * from "@opencode-ai/core/util/secret-redaction"
