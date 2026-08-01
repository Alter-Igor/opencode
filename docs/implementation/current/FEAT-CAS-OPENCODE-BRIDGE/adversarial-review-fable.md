**GO (conditional).** The design is directionally sound: a minimal four-tool surface (list/delegate/get/cancel) with `cas_resolve_tool_call` explicitly excluded closes the most dangerous escalation path (the bridge answering tool-resolution requests on behalf of a remote agent), the hard requirement on `CAS_MCP_TOKEN` with degraded-mode fallback is the right failure posture, and the prompt-level directives to treat CAS output as untrusted and never auto-transmit source code establish the correct trust boundary. However, prompt-level guarantees are advisory, not enforced, so ship only after hardening the enforcement layer.

**Must-fix items:**

1. **Enforce the no-source-code rule in the bridge, not just the prompt.** Add a payload filter/size cap on `cas_delegate` arguments (e.g., reject or redact content matching file-path globs, diff markers, or exceeding N KB) so a prompt-injected or confused model can't exfiltrate code even if it ignores instructions.

2. **Sanitize and wrap all CAS-returned content before it reaches the model.** `cas_get_run` output must be treated as untrusted *mechanically*: strip/escape anything resembling tool-call syntax or system-prompt markers, wrap in clearly delimited untrusted-content fencing, and cap output length — otherwise "treat as untrusted" is a suggestion the model can fail.

3. **Define degraded mode precisely and fail closed.** "Degraded when missing token" must mean: all four tools return a static error, no network calls attempted, no token echoed in error messages or logs, and the state is surfaced to the user at session start — plus verify the token is validated server-side (constant-time compare, no logging) rather than merely checked for presence.
