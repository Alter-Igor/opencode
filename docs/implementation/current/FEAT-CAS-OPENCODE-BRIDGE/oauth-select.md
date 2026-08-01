# CAS OAuth connect + list + select (wave 2)

## User flow

1. Terminal: `opencode mcp auth alterspective-agent`  
   - Browser OAuth (PKCE), loopback `http://127.0.0.1:19876/mcp/oauth/callback`  
   - Tokens stored in OpenCode `mcp-auth.json` (not in git)
2. In OpenCode: `/cas` or ask to connect to CAS
3. Tools: `cas_auth_status` → `cas_safe_list_agents` → user picks → `cas_select_agent` → `cas_safe_delegate`

## Config

```jsonc
"alterspective-agent": {
  "type": "remote",
  "url": "https://agent.alterspective.com.au/api/v1/mcp",
  "oauth": { "scope": "cas.access", "callbackPort": 19876 }
}
```

No static `Authorization` header (empty bearer blocked OAuth discovery).

## CAS dependency

Prod must advertise OAuth issuer as `https://agent.alterspective.com.au` (not `.io`).  
Code fix: `resolveMcpOauthIssuer()` in alterspective-agent `server.ts` — deploy required.

## Optional

- `CAS_MCP_TOKEN` still works as override for headless use.
- `CAS_AGENT_ALLOWLIST` comma list for Foundry agent ids beyond defaults.
