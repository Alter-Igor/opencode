# opencode-delegate

opencode-delegate is a small MCP server that runs on your PC. It lets an AI client (Claude Code, and later Codex or Gemini) hand coding work to OpenCode sessions. Those sessions run in a locked Docker box, not on your own account. The client gets a set of `oc_*` tools: start a session in a repo, give it a task, wait for it, answer its questions, and fetch its work back as a git branch. Nothing is merged for you.

Design and evidence: `docs/implementation/current/FEAT-OCD-001-opencode-delegate-mcp/` (start with `technical-design.md`).

The box sets `OPENCODE_DISABLE_SESSION_RETROSPECTIVES=1`. The fork's observer skips session retrospectives there: no local retrospective JSON and no POST to Keystone's audit path. Diagnostic logs and standalone learning-store operations are unchanged; learnings a retrospective would have derived are skipped too. Outside the box, leaving this flag unset keeps the fork's existing behavior.

## Security model

**The short version.** The delegated agent runs in a Docker box. The box stops it leaving, and stops it seeing your own account. It does not stop it using what is inside the box. Read "What a misbehaving agent can still do" below before you rely on it.

**What the box stops.**

- Reaching any host except three: Keystone (`identity.alterspective.com.au`), the Synapse model gateway (`synapse2-api.alterspective.com.au`), and read-only npm and PyPI caches.
- Using any Keystone service you did not choose. On Keystone, the box reaches only the chosen connections (`/mcp/c/<id>`) and the sign-in paths they need. Everything else gets `403` from the front proxy: `/mcp/dynamic` (every service on your account), `/api/mcp`, and every other connection. The exception is the `dynamic` connection, if you choose it: it reaches `/mcp/dynamic` only through the delegation gate (see "Full delegation (dynamic)").
- Seeing your Windows account, your saved logins, or your repos' `.git` folders. The box gets a copy of a repo, not the repo.
- Publishing packages. The caches are read-only.

**What a misbehaving agent can still do.**

- **Drive any session in the box.** It runs as the same user as the OpenCode server in the box, so it can read the server password. With it, it can call the OpenCode API for any session in the box: wake a session, answer its own permission requests (`always` included), and change a session's details or permissions. The bridge refuses `always` and checks who owns a session. Those checks guard what the bridge does. They do not guard the inside of the box.
- **Make model calls as you, and only model calls.** The box holds no Synapse credential (#48). `front` adds your own delegated Synapse token to exactly two routes on the model gateway: `POST /v1/chat/completions` and `GET` (and `HEAD`) `/v1/models` (no query string). Every other path (usage, fleet, operator, judgments, health, MCP) gets `403` from `front` and never carries the token. This matters: if you hold the Synapse admin role, the token itself could book, stop or deploy GPUs and run judgments; through `front` the box can only run inference and list models. Any code in the box can still spend model calls in your name while the box runs. Synapse records each call as you, through app `opencode` (`act: service:opencode`). The box cannot read the token or take it out: it never enters the box.
- **Use the chosen Keystone services, as you, with everything they can do.** The box has your sign-in for each chosen connection. Any code in the box can use those tokens directly, not only through OpenCode. So it can do anything those services allow you to do, including their write tools. Keystone logs each call. With host-held Keystone tokens on (`OCD_KEYSTONE_HOST_AUTH=1`, off by default, see "Host-held Keystone tokens" below), the box holds no Keystone token: `front` adds each connection's own token on that connection's path only. Code in the box can still use the chosen services through `front`, as you, but it has no token to take anywhere else. The bridge denies some write tools in OpenCode's permissions (see the table below), but **that deny list is not a wall**: code in the box can call the connection with the tokens and skip OpenCode. With the default set this means:
  - `rag-read` (company knowledge base, **read-only at Keystone**): search, ask and read tools only. Keystone's `rag-read` service has an allowlist tool policy, so ingest, delete, contribute and feedback are refused by Keystone itself, even for an admin owner and even with a token taken from the box (issue #56). If you choose `rag-global` instead, it is **not** read-only for an admin owner: it can fetch any public URL from the RAG server (`rag_ingest {url}`), write into the shared knowledge base, delete a collection, and open draft pull requests (`rag_contribute`).
  - `github`: anything your GitHub access allows. **This is a way out.** It could push code to a repo, or write it into an issue or gist that someone else can read.
  - `seqlogs`: read logs, plus a few tools that change shared SeqLogs state: tenant aliases other agents use (`set_tenant_alias`) and background monitors (`start_tenant_monitor`, `stop_tenant_monitor`). `ai_analyze_window` runs a model over logs that can hold personal data.

  Choose the set for the job (see "Keystone services" below). Leave out a service that can send or publish when the job does not need it.
- **Copy your tokens out.** A refresh token copied out of the box (for example through a GitHub write or a RAG URL fetch) works from anywhere until it expires or is revoked: Keystone accepts it without a client secret. `front` only stops the box's own use of other paths. The bridge removes sign-ins of services that leave the set (see "Keystone services"), but it cannot revoke them at Keystone for you. With host-held Keystone tokens on, there is no Keystone token in the box to copy.
- **Write code you might run.** Its work lands on a `delegate/<key>` branch in your repo. Review it before you run anything. `oc_collect` lists files that could run on your machine under `hostExecutableChanges`: git hooks, editor and agent config folders, executable files, and `package.json` scripts.
- **Do anything inside the box.** Edit files, run commands, install packages from the caches, read other sessions' files and inbox messages, and post inbox messages that claim to come from any session (these are stored as `verified:false`). It is one box per user.

**Which part is the wall.** The front proxy is the wall, for what the box itself can reach. The fork's MCP allowlist patch, the bridge's policy guard and the tool deny list catch mistakes in setup. They do not hold back an agent that is trying to get round them. Nothing in the box stops data or tokens leaving through a chosen service that can write.

**What can still leave the box.**

| Route | How | What limits it |
|---|---|---|
| GitHub writes | A push, issue, comment, gist or file through `github` | Only leaving `github` out of the set |
| RAG URL fetch | `rag_ingest {url}`: the RAG server fetches any public URL, so data rides in the URL | Refused by Keystone on the default `rag-read`; only reachable if you choose `rag-global` (admin owners) |
| Knowledge-base writes | `rag_ingest`, `rag_ingest_document` (admin owners), `rag_contribute` (draft PR, any member) | Same as above |
| Tokens copied out | Any of the routes above, carrying a refresh token | Works elsewhere until it expires or is revoked; revoke at Keystone |

**The parts.**

| Part | What it does |
|---|---|
| **The box** | A Docker container called `opencode-delegate`. It has no host environment, no saved logins, no API keys from your account. It runs as a non-root user with a read-only filesystem, apart from its work folders. |
| **Front proxy (the wall)** | The box has no route to the internet. Inside the box, the allowed names (Keystone, the Synapse gateway) point at a `front` proxy. It ends the TLS connection itself, with a certificate from a private CA made inside `front`, and opens its own connection to the one real host, with the name and `Host` header fixed. A swapped TLS name is refused at the handshake; a swapped `Host` gets `421`. Other names do not resolve, and there is no CONNECT proxy. Packages come from the read-only npm and PyPI caches. `front` looks up the real hosts with public DNS (`OCD_FRONT_RESOLVER`, default `1.1.1.1 1.0.0.1`); if that is blocked, it fails closed. |
| **Chosen Keystone services only** | The box gets one MCP entry per chosen Keystone connection: `ks-<id>` → `https://identity.alterspective.com.au/mcp/c/<id>`. There is no `/mcp/dynamic` entry. **The wall** is the front proxy: on Keystone it forwards only those connections' paths and the sign-in paths (with host-held Keystone tokens on, only the connection paths), and answers `403` to everything else. Code in the box cannot reach another path through it, even with the tokens. Tokens copied OUT of the box are not stopped by it (see "What can still leave the box"). The profile check, the fork patch (`OPENCODE_MCP_ALLOW`) and the bridge's check before every send say the same thing. With host-held Keystone tokens on, every entry also carries `oauth: false`: the profile check requires it, and the fork patch accepts it. They catch setup mistakes. A check that cannot be done counts as a failure. |
| **Synapse token (host only)** | You sign in to Synapse on your PC with `oc_login {server: "synapse"}` (or `opencode-delegate login synapse`). The bridge, not the box, does the Keystone sign-in as app `opencode` and exchanges it for your own Synapse token (`audience=synapse`, offline). `front` removes any `Authorization` or `x-api-key` the box sends to `synapse2-api` and sets yours. The token sits only in `<home>\front\synapse-auth.conf` (one nginx variable; written then renamed; read-only in `front`; never in a log). See "Synapse sign-in" below. |
| **Per-user OAuth** | You sign in to Keystone yourself (`oc_login`). The tokens live only in the box's own data volume. They only work through Keystone, as you, and Keystone logs every call. On every start, reuse and set change the bridge removes stored sign-ins for any entry that is not a current `ks-<id>`. With host-held Keystone tokens on, you sign in on your PC instead, the tokens stay on the host, and the box's sign-in store is emptied (see "Host-held Keystone tokens"). |
| **Tool deny list (convenience)** | OpenCode denies these tools in the box profile and in every session, after every other rule, so a session's rules cannot give them back: `ks-rag-global_rag_ingest`, `_rag_ingest_document`, `_rag_delete_collection`, `_rag_contribute`, `ks-seqlogs_set_tenant_alias`, `_start_tenant_monitor`, `_stop_tenant_monitor`. Change it with `OPENCODE_DELEGATE_KEYSTONE_TOOL_DENY` (comma list of `ks-<id>_<tool>`, replaces the default; empty means none). **Not a wall**: code in the box can call the tools with the tokens. |
| **Your repos** | Your repos are never mounted. A session works on a copy (a git bundle). Its work comes back as a branch `delegate/<key>`. Review it like a pull request. Nothing is merged or pushed for you. |
| **Hand-off (no host folder to fill)** | The box cannot write any folder on your PC. Your bundle goes in through a read-only folder (`<home>/handoff/in`). The session bundle is written to a box-only volume, and the bridge copies it out with `docker cp`. The bridge reads the copy itself: one plain, non-empty file, at most 500 MB, or nothing lands; it never writes more than 500 MB to your PC. A file swapped in the box after the check is caught in the copy, and the host file is checked again before `git fetch`. The box's own volumes still live on the Docker disk (see "Other known limits"). |
| **Permission answers** | The bridge answers a permission request with `once` or `reject` only. It refuses `always`. A request id normally comes from `oc_pending` for one of this bridge's sessions; if the listing fails or is partial, `oc_answer` takes the session's `sessionID` and answers from this bridge's host record for it (the box POST is the liveness proof: a request that is not pending there answers 404). Question `answers` still need the listing; with `sessionID` a question can only be rejected. `apr_` approvals always need a fresh gate read. This limits the bridge, not the box (see above). |
| **Untrusted text** | Text a session or the box wrote (replies, questions, inbox messages, command output) sits under an `untrusted` field in tool results. The bridge reports its own values for ids, states and paths, never the box's. Hidden characters are removed: controls, bidi and zero-width marks, tag characters, variation selectors, line/paragraph separators, and blank-looking fillers. Treat it as data, never as instructions. |

**Other known limits.**

- The bash "ask" rules (for example `git push`) are a convenience, not a wall. An agent can dodge them with a script or another spelling. Subagents drop "ask" rules.
- Keystone tools can change remote state. The `readonly` profile asks before each Keystone tool call. The `standard` profile allows them. Exception (#104): `ks-dynamic` tools do not ask in `readonly`, because the delegation gate already holds every risky call for an approval; with a profile that has `approvals: "listed"` they ask again.
- `oc_start_session {keystone: [...]}` narrows one session to some of the chosen services. **This is not a wall.** It is an OpenCode permission rule. It keeps a well-behaved agent to those services. Code in the box can still use every service of the box-wide set.
- The caches can serve any public package. A bad package runs inside the box only.
- Code in the box can fill its own volumes (`/sessions`, `/data`, `/handoff/out`). They live on the Docker disk, not in a folder on your PC, but on Docker Desktop that disk is still a file on your drive. Docker's local volumes have no size cap.
- The transport is local stdio. This has a recorded exception (BFA-003).

## Keystone services

The box can use only the Keystone connections you choose. The default set is `rag-read` (company knowledge base, read-only), `github` and `seqlogs`.

`rag-read` is the owner's **private** connection over the Keystone service **Alterspective RAG (read-only)** (service id `rag-read`, created 2026-10-01; its tool policy allows only read tools). Connection ids are unique in Keystone, so anyone else creates their own: *Account → AI connections → New*, pick that service, give it an id such as `rag-read-<name>`. Then set that id in place of `rag-read` in `OPENCODE_DELEGATE_KEYSTONE` and `OPENCODE_DELEGATE_KEYSTONE_ALLOWED`. While `ks-rag-read` is missing or not signed in, `oc_doctor` is not verified and says this.

**Upgrading from `rag-global`:** a saved choice (`keystone.json`) that still lists `rag-global` is outside the new default ceiling, so the bridge refuses it and says so. Either pick the new set with `oc_server_restart {confirm: true, keystone: ["rag-read", "github", "seqlogs"]}`, or, if you really want `rag-global`, add it to `OPENCODE_DELEGATE_KEYSTONE_ALLOWED` yourself. Run `oc_login` once for `ks-rag-read`.

- **See the set:** `oc_doctor` (`keystone`, with each entry's sign-in state) or `oc_list_models` (`keystone.connections`).
- **Change it for the whole box:** `oc_server_restart {confirm: true, keystone: ["rag-read", "github"]}`. The choice is saved in the bridge home (`keystone.json`), so later restarts and other bridges use it. It rebuilds the profile, the MCP policy and the front proxy's Keystone paths, then restarts the box. Other bridges' sessions are interrupted, so it needs `force: true` while other bridges use the box.
- **Narrow one session:** `oc_start_session {..., keystone: ["rag-read"]}`. It must be a subset of the box-wide set. Convenience only (see "Other known limits").
- **New services need a sign-in:** run `oc_login` once. With no `server`, it signs in every entry that needs it, one browser tab at a time.
- An id is not checked against Keystone. A wrong id just fails to connect, and `oc_doctor` shows that entry as `failed` or `missing`.
- `OPENCODE_DELEGATE_KEYSTONE` (comma list) sets the default for a bridge home with no saved choice.

**The owner's allowed list (ceiling).** A tool call can only pick ids from `OPENCODE_DELEGATE_KEYSTONE_ALLOWED` (comma list), set in this MCP server's `env` in the client config and read when the bridge starts. Without it, the allowed list is the default set. `oc_server_restart {keystone}` with any other id gets `policy_violation` and changes nothing; so does a saved choice outside the list. Why: `confirm: true` is a value the calling model supplies, and Keystone gives a signed-in browser a code with no consent screen, so text from the box could talk the host agent into adding a service. Only you can raise the list: edit the env, then restart the MCP client.

**High-risk connections.** One connection can relay to many services. In this estate, `cas` runs agents that read your mail, Teams chats and calendar; a `keystone-admin`-backed connection reaches the Keystone admin tools (`execute-tool`, `mint-impersonation-token`, `create-api-key`); `vault*` serves secrets. `oc_doctor` warns when an id starting with `cas`, `vault`, `keystone-admin`, `m365`, `monday`, `hubspot`, `stripe`, `xero` or `sharedo` is in the allowed list or the set. Allow one only for a job that needs it, and take it out after.

**Old sign-ins are removed, not revoked.** When an entry leaves the set, the bridge deletes its stored sign-in from the box (names only are logged, and listed by `oc_doctor` under `live.signIns.removedBefore` with the client id). Keystone's revocation endpoint only revokes device-grant tokens, so the bridge cannot revoke these. Revoke them yourself in Keystone by client id (`revoke-oauth-tokens`).

## Full delegation (dynamic)

Issue #104, owner decision 2026-10-04: a delegated task can use the same Keystone tools you can, so a sub-agent can do what its caller does. This replaces the earlier rule "never `/mcp/dynamic`" (R4-01) for the boxes that choose it.

```
box (no tokens) --> front (adds your dynamic token) --> mcp-gate (profile + approvals) --> Keystone /mcp/dynamic
```

- **Discovery, not a long tool list.** The box gets one entry, `ks-dynamic`, with Keystone's three search-first tools (`search-tools`, `get-tool-schema`, `execute-tool`), exactly what your own agents use. It finds tools as it needs them.
- **The delegation gate** (`mcp-gate/`, a small container on your PC) sits between front and Keystone. The box cannot reach it directly or go around it: the box is not on the gate's network, and front sends only `/mcp/dynamic` there. The gate:
  - refuses tools the profile hides, and removes them from search results;
  - makes **risky tools wait for an approval**: anything that may send data out, change something or run code (send mail, post, create, delete, execute code). The risk words are copied from CAS (`src/core/domain/tool-risk.ts`). A name with no read verb counts as a change (fail closed);
  - never logs your token or a call's arguments.
- **Approvals.** A held call returns at once with "needs approval `apr_...`". `oc_pending` lists it (kind `approval`, box-wide, the call details under `untrusted`). `oc_answer {requestID: "apr_...", kind: "approval", reply: "once"}` lets **that exact call** (same tool, same arguments) run once when the agent retries it within 30 minutes; `reply: "reject"` refuses it. `always` is refused. Approvals live in the gate's memory: a restart forgets them.
- **Read-only sessions** (owner decision A, 2026-10-05): OpenCode does not ask before `ks-dynamic` calls, so you are asked once, by the gate, and only for risky tools. If your profile has `approvals: "listed"`, the gate no longer asks for every risky tool, so read-only sessions ask before each `ks-dynamic` call again.
- **The profile** (optional, yours): `OPENCODE_DELEGATE_DYNAMIC_PROFILE` in this MCP server's env, JSON with CAS's field names. A profile only narrows; empty means every tool, risky ones asked first.

  ```json
  {"allowedToolPatterns": ["github__*", "rag-read__*"], "deniedToolPatterns": ["github__delete_*"], "approvalRequiredToolPatterns": ["github__merge_*"], "approvals": "risky"}
  ```

  `approvals: "listed"` asks only for the listed patterns. Patterns are CAS's (`*` = any run). Tool names are Keystone's `<namespace>__<tool>`. A damaged profile stops the start; it never falls back to "everything". A changed profile restarts the box on its next use.
- **Turn it on:**
  1. host-held tokens must be on (`OCD_KEYSTONE_HOST_AUTH=1`): with tokens in the box, in-box code could skip the gate, so the bridge refuses `dynamic` without it;
  2. add `dynamic` to `OPENCODE_DELEGATE_KEYSTONE_ALLOWED`, then restart the MCP client;
  3. `oc_server_restart {confirm: true, keystone: ["dynamic"]}` (or with your other ids), then `oc_login` for `ks-dynamic`.
- `oc_doctor` shows `gate` (reachable, profile, how many calls wait) and always flags `dynamic` as high risk.
- **What it does not stop:** a tool the profile allows and the risk words read as a read runs without asking. Keystone's own per-service tool policy (`require_approval`, `deny`) is still applied after the gate, and every call is audited under your name.

## Host-held Keystone tokens (off by default)

Today the box signs in to each chosen Keystone connection itself and keeps the tokens in its data volume. Code in the box can read them. With `OCD_KEYSTONE_HOST_AUTH=1` the tokens move to your PC instead (issue #67, CAS ADR-037: the sandbox holds no keys).

**How it works with the flag on.**

- `oc_login` signs you in on your PC, one connection at a time, on the same loopback port (`19876`). The box takes no part.
- The refresh token is kept on your PC, encrypted with Windows DPAPI (`<home>\keystone\<id>.refresh.dpapi`). The bridge renews the access token in the background, like the Synapse token.
- The access token goes only into `<home>\front\ks-auth-<id>.conf` (one nginx variable, read-only in `front`). `front` sends it on `/mcp/c/<id>` and nowhere else. The box's sign-in paths are no longer forwarded.
- Each box entry is `{type: "remote", url, oauth: false}`, so OpenCode does no sign-in of its own. After a new token is written, the bridge asks the box to connect the entry, because OpenCode does not reconnect on its own.
- On every start, reuse and set change the bridge empties the box's sign-in store (`mcp-auth.json` becomes `{}`). It records the names and client ids it removed, never a token.
- When a connection leaves the chosen set (`oc_server_restart {keystone}`), its `ks-auth-<id>.conf` is emptied at that start, so no bearer for it stays on disk. Its host sign-in stays in `<home>\keystone` until you revoke the client id and delete its files.
- `oc_doctor` shows a `keystoneAuth` section: each connection's state and expiry, whether `front` loaded a token for it, whether `front` lists exactly the chosen ids, and whether the box store is empty. `verified` is false if the box store holds anything.

**Turn it on.**

1. Set `OCD_KEYSTONE_HOST_AUTH=1` in this MCP server's `env` in your client config. Set it for every bridge that shares the same home, or they will build different profiles and `front` configs. A bridge with the other value is refused with an error that names `OCD_KEYSTONE_HOST_AUTH`.
2. Restart **every** client that runs a bridge on this home, so each one has the flag. Only then restart the sandbox: `oc_server_restart {confirm: true}`. Add `force: true` if other bridges still hold the sandbox (their running sessions are interrupted). The profile, `front`'s config and the box store all change, so a restart is needed.
3. Run `oc_login {server: "ks-<id>"}` for each chosen connection (or `oc_login` with no server for all of them).
4. Run `oc_doctor`. Check `keystoneAuth.ok` is true and `verified` is true.
5. Revoke the old box sign-ins in Keystone by client id. `oc_doctor` lists them under `live.signIns.removedBefore` (Keystone tool `revoke-oauth-tokens`). The bridge cannot revoke them for you (see "Old sign-ins are removed, not revoked").

**A box entry shows `failed`.** Run `oc_login`. A connection whose host token is still valid is only reconnected in the box, with no browser consent. `oc_login {server: "ks-<id>", force: true}` signs in again anyway. Each bridge also reconnects signed-in entries on its own box every minute, and `oc_doctor` does it before it reports.

**Turn it off.**

1. Remove the variable from every client that runs a bridge on this home, restart those clients, then `oc_server_restart {confirm: true}` (with `force: true` if other bridges hold the sandbox).
2. Run `oc_login`: the box signs in itself, as before.
3. Clean up what the host held. The access tokens in `<home>\front\ks-auth-<id>.conf` stay valid until they expire (about one hour), even after the files are no longer used. Delete those files, or wait out the hour.
4. Revoke the host's client ids in Keystone (`revoke-oauth-tokens`). Each one is in `<home>\keystone\<id>.state.json` as `clientId` (an id, not a secret).
5. Delete the `<home>\keystone` folder. It holds the DPAPI-encrypted refresh tokens and the state files.

## Synapse sign-in

The box has no Synapse key. Model calls go out through `front`, which adds **your** delegated Synapse token.

- **Sign in once:** `oc_login {server: "synapse"}`, or `bun <checkout>\alterspective\delegate-mcp\src\cli.ts login synapse`. Your browser opens on Keystone (app `opencode`). The bridge listens on `127.0.0.1:1459` for the answer and checks it is the one it asked for.
- **Silent renewal:** each bridge checks every 15 seconds. When the token is 80% through its life (the shorter of Keystone's `expires_in` and the token's own `exp`), one bridge holds the home lock, keeps the rotated refresh token, then publishes the new access token. `front` checks a private copy of the config, reloads, and waits up to 20 seconds for a running worker to acknowledge that attempt. A reload that can clear by itself (`config_invalid`, `unverified` when no worker replied in time, `busy` when another reload was running) is retried on later ticks without waiting for another token renewal: first after one tick, then doubling, at most 5 minutes apart. `front_not_running` and `config_changed` are not retried on the timer: `front` loads the current files when it starts, and a changed `servers.conf` needs `oc_server_restart {confirm: true}`. If `nginx -t` refuses a new config, `front` keeps pointing at the last one. The refresh token lasts 30 days from sign-in as configured on the Keystone app `opencode`; that lifetime is **not verified live**. After it ends, sign in again.
- **Where things are kept:**
  - The refresh token: only on your PC, encrypted with Windows DPAPI for your Windows user (`<home>\synapse\refresh.dpapi`). Never in the box, a log, or a JSON file.
  - The app credentials (the `opencode` broker key and client secret): read when needed from `OPENCODE_KEYSTONE_BROKER_KEY` / `OPENCODE_KEYSTONE_CLIENT_SECRET`, else from the vault (`az keyvault secret show --vault-name alterspective-vault --name opencode-keystone-broker-key` / `opencode-keystone-client-secret`). Kept in memory only.
  - The access token: `<home>\front\synapse-auth.conf`, mounted read-only into `front` only. It can only set one variable (a token of at most 3,800 characters). `oc_doctor` asks a running worker for the loaded config hashes on a front-only loopback listener. It checks the matching private copies, the host include, and the two allowed Synapse model routes. A missing or mismatched reply is unverified; `nginx -T` is not used as proof of what is loaded. No token is returned by the listener or doctor.
  - `front` is reloaded only through its baked `front-reload` script. It copies the files before checking the startup hash of `servers.conf` and the include's exact shape. nginx reads those immutable copies, so a later host write cannot change a pending reload. Every attempt has a fresh ID: even identical content needs a new worker reply. A timeout is a failure to verify; nginx may still finish the checked reload later. Old copies are removed only after a new worker acknowledges. A helper that dies releases its local lock, so a later attempt can retry. The entrypoint prepares the same checked copies before nginx starts.
- **Fails closed, two ways:**
  - **Needs sign-in:** Keystone refuses the refresh (for example `invalid_grant`: revoked, expired, or your Synapse role removed), or no refresh token is stored. The include is emptied, `front` sends no credential, Synapse answers `401`, and `oc_doctor` says `needs_sign_in`. Run `oc_login {server: "synapse"}`.
  - **Expired, retrying:** a passing failure (Keystone down or slow, a DPAPI read error). The token stays in `front` until it expires; then the include is emptied (no model calls) but the bridge keeps retrying with backoff (30 s, doubling, at most 10 min), and model calls work again as soon as a renewal works. `oc_doctor` says `expired` with the next retry time.
  - If the new refresh token cannot be saved (DPAPI write error), it stays in that bridge's memory and is saved on a later tick (`oc_doctor`: `pendingSave`). The bridge keeps it even if publishing the access token or state also fails. When state can be written, a marker makes other bridges wait rather than use the old stored token. A later sign-in supersedes the pending token. **If that bridge exits before the save works, the unsaved token is lost**: the next refresh uses the old stored token, Keystone refuses it, and you sign in again.
- **Check it:** `oc_doctor` → `synapse`: `state` (`signed_in` / `expired` / `needs_sign_in`), `user`, `actor`, `expiresAt`, `refreshAt`, `refreshTokenStored`, and whether `front` has the include loaded. Never a value.
- **Revoke it:**
  - Your own sign-in only: delete `<home>\synapse\refresh.dpapi`; the token in `front` stops at its expiry (about an hour at most).
  - At Keystone: remove your Synapse role, or ask a Keystone admin to run `revoke-oauth-tokens {clientId: "opencode"}`. That second one signs out **every** user of app `opencode`, not only you.
- `OPENCODE_DELEGATE_SYNAPSE_REFRESH_FRACTION` (0.01-0.95, default 0.8) moves the renewal point. It is for tests.

## Models (Synapse only)

The box uses only Synapse. This is an owner rule, not a setting.

- **Only one provider:** the box profile sets `enabled_providers: ["synapse"]`. Every other provider in your global OpenCode config is dropped. The bridge log names each dropped provider in a warning when the box starts.
- **Only registered models:** when the box starts, the bridge reads Synapse `GET /v1/models` on your PC with your delegated Synapse token. It has a 4-second limit and the body is capped. The box offers that list as `synapse/<id>`. `synapse/auto` (Synapse's own routing) is always added first. Models Synapse marks as not able to chat (embed, rerank or image only) are left out.
- **Default `synapse/auto`:** your `model` and `small_model` are kept only when they are registered Synapse models. Otherwise the box uses `synapse/auto` and says so.
- **Task roles (D4, owner decision 2026-10-10):** when Synapse publishes per-role benchmark fit (`capabilities.suitability` on its model list), `oc_send` and `oc_start_session` accept `taskRole` (e.g. `code`, `qa`, `architecture`): the bridge picks the best-fit model the box actually offers (never a retired one) and reports it as `taskPick {model, score}`; `oc_list_models` shows the roles Synapse knows and the ranked models per role. The role vocabulary is Synapse's and is discovered, never hardcoded. No fit data, unknown role or unreadable list: the normal default model stands and the reason is reported — a hint never blocks a send. An explicit `model` always wins over `taskRole`. The gateway-side half (route `auto` on `x-task-role`) is Synapse issue #1918.
- **When the list can't be read** (no sign-in yet, Synapse down, a bad answer): the box offers `synapse/auto` only and still starts. The list is read again at the next box start. A model added to or retired from Synapse does not make a running box `profile_changed`.
- **Every send names a model.** `oc_send` refuses a model from any other provider with `invalid_input`. With no `model`, it sends the session's saved model when the box still offers it. Otherwise it sends the box default (read from the box within 5 seconds, else `synapse/auto`). `modelFallback` in the result names the model actually sent.
- **Models that cannot use tools are not offered.** OpenCode always sends tools, so a model Synapse marks `capabilities.tools: false` is left out of the box's list.
- **When a model fails**, the box does not switch models by itself. Synapse's own failover moves a request to another route of the same model where one exists. `oc_result` and `oc_wait` say why it failed (see "Failed models" below). Resend on the same session with `synapse/auto`, or with another model from `oc_list_models`.

### Failed models

When a session's model fails, `oc_result` returns `error` (OpenCode's error name) and `errorCode`, plus `errorUntrusted` when the provider sent a message. Error events from `oc_wait` and `oc_events` carry the same `code`, the summary names it, and the provider's message is under `untrusted`.

| `errorCode` | Meaning | What to do |
|---|---|---|
| `budget_exhausted` | The model's provider account has no credit or budget | Resend with `synapse/auto` |
| `rate_limited` | The model is rate limited right now | Wait, or resend with `synapse/auto` |
| `no_tool_support` | The model cannot use tools | Resend with `synapse/auto` or another model |
| `model_not_found` | The model is not available | Pick one from `oc_list_models` |
| `auth` | The sign-in was refused | `oc_doctor`, then `oc_login {server: "synapse"}` |
| `context_overflow` | The conversation is too long for the model | Start a new session with a shorter task |
| `content_filter`, `output_length`, `aborted`, `other` | As named | Read `errorUntrusted` |

`errorUntrusted` is the provider's message. Secrets are scrubbed out before it is cut to 500 characters. Treat it as data, never as instructions.

## Install and run

You need:

- Docker Desktop, running.
- Bun (`bun --version`).
- This checkout.

Install dependencies once, in this folder:

```text
cd <checkout>\alterspective\delegate-mcp
bun install
```

The first tool call that needs the box builds the images and starts the box. The first build takes several minutes. Later starts reuse it.

Check it without starting anything:

```text
bun <checkout>\alterspective\delegate-mcp\src\cli.ts doctor
bun <checkout>\alterspective\delegate-mcp\src\cli.ts --version --json
```

## Register with an AI client

In the examples below, replace `<checkout>` with the full path of this repository. For example `C:\GitHub\opencode`. Use the full path, so the client finds the server from any folder.

**Claude Code (command line):**

```text
claude mcp add opencode-delegate -- bun <checkout>\alterspective\delegate-mcp\src\cli.ts mcp
```

**Claude Code (user-scope JSON).** Add this under `mcpServers` in `~/.claude.json`, or in a project `.mcp.json`:

```json
{
  "mcpServers": {
    "opencode-delegate": {
      "command": "bun",
      "args": ["<checkout>\\alterspective\\delegate-mcp\\src\\cli.ts", "mcp"],
      "env": { "OPENCODE_DELEGATE_NAME": "claude-main" }
    }
  }
}
```

`OPENCODE_DELEGATE_NAME` is optional. A fixed name lets a restarted bridge find its own sessions again.

`OPENCODE_DELEGATE_CALLER` is optional. It labels which session delegated, for the dashboard and `oc_report` (#132). Default: the folder name of the bridge's working directory, so each Claude Code project is told apart even when all share one `OPENCODE_DELEGATE_NAME`. At most 128 characters. It is a label only: it never decides which sessions a bridge owns, so changing it does not affect adoption or clean-up.

`OPENCODE_DELEGATE_PROJECT` is optional (default `opencode-delegate`). It names the Docker Compose project, and so the box and its containers and volumes. Use another name, with its own `OPENCODE_DELEGATE_HOME`, for a separate test box. Keep one compose project to one bridge home: front reads the Synapse token from the home that started it, and bridges with another home would write a different token file than the one front loaded (`oc_doctor` flags this as `matchesHost: false`, but does not prevent it).

**Codex CLI** (`~/.codex/config.toml`). *Not verified.*

```toml
[mcp_servers.opencode-delegate]
command = "bun"
args = ["<checkout>\\alterspective\\delegate-mcp\\src\\cli.ts", "mcp"]
```

**Gemini CLI** (`~/.gemini/settings.json`). *Not verified.*

```json
{
  "mcpServers": {
    "opencode-delegate": {
      "command": "bun",
      "args": ["<checkout>\\alterspective\\delegate-mcp\\src\\cli.ts", "mcp"]
    }
  }
}
```

## First run

Ask your client to do these in order:

1. `oc_doctor` — checks Docker, the box, the profile, and the Keystone sign-in state.
2. `oc_login` — opens your browser to sign in to Keystone. Do this once; the sign-in is kept in the box.
   Then `oc_login {server: "synapse"}` once, so the box can make model calls as you.
3. `oc_start_session {directory: "C:\\GitHub\\my-repo"}` — copies the repo into the box and starts a session.
4. `oc_send {sessionID, message}` — gives it a task. It returns a `cursor`.
5. `oc_wait {sessionIDs: [sessionID], until: ["idle", "needs_input"], cursor}` — waits until it finishes or needs you.
6. If it needs input: `oc_pending`, then `oc_answer`.
7. `oc_result {sessionID}` — the last reply, a diff summary and the todo list.
8. `oc_collect {sessionID}` — fetches branch `delegate/<key>` into your repo. Review it like a pull request.

## Watching sessions

`watch` prints one line per event that needs attention. It never starts or stops the box.

```text
bun <checkout>\alterspective\delegate-mcp\src\cli.ts watch --json
```

In Claude Code, run that command with the Monitor tool. Each line (idle, needs input, error, not started, stream gaps) then arrives as a notification. Use `--session <id>` to watch one session.

## Channels (research preview, off by default)

Claude Code channels let the server push events into the session without a tool call. This is a research preview, so it is off unless you ask for it.

- Start the server with `--channels`: `bun <checkout>\alterspective\delegate-mcp\src\cli.ts mcp --channels`.
- Start Claude Code with the development flag, because this server is not on the channel allowlist: `claude --dangerously-load-development-channels server:opencode-delegate`.
- Team or Enterprise organisations must also turn channels on in their policy.

What is pushed: a session became idle, needs input, hit an error, or did not start; and a new message arrived in this bridge's inbox. Each push is one line written by the bridge. It holds session ids and states only, never session text. Pushes are grouped, at most one per second. The method is `notifications/claude/channel` with `{content, meta}`; `meta` carries `type`, `state`, `sessionID` and `requestID` when they apply.

## Tools

Each result is at most 32,000 characters. When a result is too big, whole list items are dropped from the end and `_truncated` says which list and how many. Paging keys such as `next` are always kept, so page on with them.

| Tool | What it does |
|---|---|
| `oc_doctor` | Health report: Docker, box image and version, isolation level, MCP entries, the chosen Keystone services and their sign-in state, the owner's allowed list and high-risk warnings, egress (front config for that set, read-only mount, aliases, no CONNECT proxy), live checks (`live`: sign-ins stored in the box are only for the chosen set; the config files `nginx -T` shows (what nginx would load) equal the generated file; live mount modes from `docker inspect`; sign-ins removed earlier, to revoke), guard verdict. `verified` says whether every check could be done and passed. |
| `oc_login` | Keystone sign-in. With no `server`, every `ks-<id>` entry that needs it, one at a time; or one entry, e.g. `{server: "ks-github"}`. `{server: "synapse"}` signs you in to the model gateway on your PC (see "Synapse sign-in"). Opens your browser. |
| `oc_list_models` | Models the box can use (`synapse/<id>`, default `synapse/auto`; see "Models (Synapse only)"), the roles Synapse publishes fit data for (`roles`), and the Keystone services it can use. |
| `oc_start_session` | Copies a repo into the box and starts a session. Returns `sessionID` and a web UI link. `keystone` narrows the session to some of the box's Keystone services (not a wall). `taskRole` sets the session's default model from Synapse's live fit data (see "Task roles"). |
| `oc_send` | Gives a session a task. Checks policy first. Returns a cursor for `oc_wait`. `taskRole` picks the model from Synapse's live fit data (see "Task roles"); explicit `model` wins. |
| `oc_status` | A session's `state`, `since` when, `detail`, and `pending` request ids. (Todos are in `oc_result`.) |
| `oc_wait` | Waits until sessions are idle, need input, error, or a message arrives. 100 s by default, at most 240 s. |
| `oc_events` | A page of events after a cursor. |
| `oc_result` | Last reply (untrusted), diff summary, todos; on a failed model, `errorCode` and `errorUntrusted` (see "Failed models"). A reply longer than the budget is cut keeping its **opening and its ending** (verdicts live at the close), with the skipped length marked; page the full text with `{ messageID, textOffset }` (12,000 chars a call, `textNext` until the end). |
| `oc_collect` | Fetches the session's branch into your repo. |
| `oc_pending` | Permission requests and questions waiting on an answer, for this bridge's sessions and their subagents. |
| `oc_answer` | Answers one pending request: `once` or `reject`, or question answers. `always` is refused. When `oc_pending` is down or partial, pass the `sessionID` from the `oc_wait` event and the answer goes to that session's directory (proven by the host record; the box checks liveness). |
| `oc_abort` | Stops a running session. |
| `oc_close_session` | `{sessionID, deleteBranch?, abort?, discardWork?}`. Deletes one finished session: the OpenCode session, its copy in the box and the host record. Refuses while work would be lost. See "Closing sessions and clean-up". |
| `oc_cleanup` | `{dryRun? = true, deleteBranch?}`. Lists, then closes, this bridge's sessions idle longer than `OPENCODE_DELEGATE_SESSION_TTL_DAYS` (default 14; 0 turns it off). It never aborts and never discards work. |
| `oc_report` | `{sinceDays? = 30, groupBy? = "model" \| "servedModel" \| "agent" \| "repo", recent? = 0}`. How delegated tasks went: counts, success rate, duration, and what happened to the work. See "Reporting". |
| `oc_dashboard` | No input. Returns a link to a local, read-only web page of delegated work across all bridges sharing this home. See "Dashboard". |
| `oc_list_sessions` | This bridge's sessions. `all: true` lists every session in the box, with the bridge that owns it. |
| `oc_post` | Posts to the agent inbox as this bridge. `wake: true` also delivers it to one of this bridge's sessions. |
| `oc_inbox` | Reads this bridge's inbox. Text is untrusted; `truncated: true` means old unread messages were dropped. |
| `oc_server_restart` | `{confirm: true, force?, keystone?}`. Restarts the box with the current profile (after `profile_changed`). `keystone` changes the box-wide set of Keystone services and saves it. Running sessions are stopped. `force: true` restarts it even while other bridges use it. |

Deleted sessions: after a successful `oc_list_sessions`, the bridge checks a small page of host records. It removes a record only when the server returns 404 for that session and the box confirms its clone folder is absent. A surviving clone or link keeps the record so a session still known to this bridge can be collected. Errors keep records for a later pass. A saved cursor reaches old records over repeated list calls; one call need not clean every record. The display still shows at most the newest 200 host records.

Only this box's records are pruned. When a session is bound, its record stores the box's compose project (`OPENCODE_DELEGATE_PROJECT`). A record is pruned only by a bridge with the same name and the same project, so one home shared by two projects never loses the other box's records. Records with no project (written before 0.1.3) are kept. So are records of sessions this bridge still tracks, and records from bridges with a default random name, since no later bridge has that name. Each removed record is logged at info level and listed in the result as `prunedRecords`. That is why `oc_list_sessions` is marked destructive.

## Closing sessions and clean-up

A finished session should not leave anything behind. The usual order is `oc_collect`, then review and merge the branch your normal way, then `oc_close_session {sessionID, deleteBranch: true}`.

**What a close refuses:**

- A session that is running or needs input. `abort: true` stops it first, and its work is still checked afterwards.
- A session or copy that cannot be checked. Retry later. `discardWork` never overrides a check that failed.
- A copy that holds any of these:
  - commits no host branch has, including every stash entry;
  - uncommitted files;
  - git-ignored files such as `dist/` or `.env`.

  The refusal gives the counts. For git-ignored files it also names up to 10 of them (plain names only). `oc_collect` fetches commits; ask the agent to commit loose files. `oc_collect` never carries git-ignored files, so copy any you need out of the box by hand. `discardWork: true` deletes them on purpose.

**What never blocks a close:**

- Dependency and cache folders, at any folder depth: `node_modules`, `.cache`, `.turbo`, `__pycache__`, `.pytest_cache`, `.venv`, `coverage`.
- Commits that only the reflog holds (replaced by an amend or a reset). These are reported as `discardedCommits`.

**Branches:** `deleteBranch: true` deletes `delegate/<key>` only when another host branch contains it. `discardWork: true` deletes it unmerged. A branch that is checked out anywhere, or a symbolic ref, is never deleted. No other branch is touched.

**Work that appears during a close:** if new work shows up while the session is closing, the copy and the host record are kept. `oc_collect` can still fetch it, even after a bridge restart. It fetches from this bridge's own record of a session in this box, when the box no longer knows the session.

**The sweep:**

- `oc_cleanup` uses the same checks, but it never aborts and never discards. A session it keeps is listed with its reason.
- `dryRun` is on by default and leaves the sweep position unchanged, so the real run sees the same sessions.
- Each call checks a small page of records and continues where the last one stopped.
- It sees only sessions with this bridge's name.

## Reporting

The bridge keeps one small record per task on your PC, at `<home>/workspaces/reports/<key>.json`. The box never sees this folder. A record holds metadata only: model sent, the models Synapse served (#76), agent, repo name, the caller (#132, which session delegated: the bridge's working-directory folder name, or `OPENCODE_DELEGATE_CALLER`; not an ownership key), times, send count, outcome, commits collected and what happened to the work. It never holds prompt or answer text, file contents or error bodies. An error is kept only as a known error code, else `other`.

- **When records change:** start, send, wait, result, collect, close and the sweep. A tool never waits for a record to be saved. Saves run in the background and are flushed before `oc_report` reads and at shutdown. A failed save is logged once and never fails a tool.
- **Several bridges** can share the home folder. Each record has its own lock file, so two processes do not lose each other's counts. In one rare race (an old lock being taken over while its owner wakes up), two writers can still overlap; the worst case is one lost count. This is logged as `lock_relink_failed`.
- **Kept for:** 90 days. Beyond the newest 2,000, every record whose work is no longer open (collected or closed) is dropped too; open tasks are kept.
- **`oc_report`** returns `notes`, `sinceDays`, `groupBy`, `since`, `totals`, `groups` (each `name` under `untrusted`), and `recent` when asked for. `totals` and each group hold `tasks`, `completed`, `error`, `aborted`, `unknown`, `notSent`, `running`, `finished`, `successRate`, `durationMs {median, p90, samples}` and `dispositions {collected, closedDiscarded, open, closedClean, swept}`.
  - `unknown` includes `notSent` (started but never given a task). `finished` = completed + error + aborted + unknown − notSent, so tasks never sent are left out.
  - A task nobody waited on is settled at close from the session's state: idle is `completed`, an error state or a session that never started is `error`, a real abort is `aborted`, anything else is `unknown`.
  - `groupBy: "model"` is the model the bridge sent, so a `synapse/auto` row does not say which model Synapse picked. `groupBy: "servedModel"` (#76) does: each task is grouped by the model that served most of its calls.
  - **Where served models come from:** Synapse names the model it used in the response header `x-synapse-served-model`. front's access log writes that header and the session id the box's OpenCode sends (`x-opencode-session`); nothing else from the request (no URI, body or token). After `oc_result` and at close, the bridge reads front's log since the task's first send (`docker logs --since`, the newest 20,000 lines at most, in the background) and stores the counts in the record. front's log is shared by every session, so on a busy box a long task's earliest calls can fall outside those lines and its counts come out low; a later read can raise them. A read after a box restart sees fewer calls (front's log starts again), so it never replaces a larger count. `(unknown)` means it was never read.
  - The session id is written by the box, and the box is one trust zone, so one session could claim another's. That skews these counts only; treat them as a guide.
  - `groupBy: "caller"` (#132) shows which session delegated. Several Claude Code sessions share one bridge name, so the bridge name cannot tell them apart; the caller can. Tasks recorded before 0.5.1 have no caller and group under `(unknown)`. `recent` rows carry `caller` under `untrusted`.
  - Token counts are a lower bound: they cover only the messages `oc_result` fetched.

## Dashboard

`oc_dashboard` returns a link to a read-only web page, "Delegated work", for you to open in a browser. It shows, across every bridge sharing this bridge home: whether the box is running and how many tasks are running; which sessions delegated (#132: the caller, the project folder of each Claude Code session, or `OPENCODE_DELEGATE_CALLER`; a task recorded before 0.5.1 is listed under its bridge name) with running, last 24 hours and last 7 days; the tasks running now; the 200 most recent tasks of the last 7 days (session, bridge, repo, model sent, model Synapse served, state, duration); and the models served over 7 days. It reads the same task records as `oc_report` (see "Reporting") and refreshes every 5 seconds.

- **Local only.** The page is served on `127.0.0.1` at a random port, behind a random path token in the link. Only GET is answered, and a request whose `Host` header is not `127.0.0.1:<port>` is refused. The link works only on this machine.
- **Stops with the bridge.** It starts on the first `oc_dashboard` call (a second call returns the same link) and never keeps the bridge running.
- **Read-only.** It never starts the box and never calls Docker. Repo and model names are shown as plain text.

## Troubleshooting

| Error code | What it means | What to do |
|---|---|---|
| `sandbox_unavailable` | Docker Desktop is not running, or Docker cannot be reached. There is no fallback to your own account. | Start Docker Desktop, then run `oc_doctor`. |
| `profile_changed` | The running box was started with a different profile, image, policy or Keystone set than this bridge expects. | Run `oc_server_restart`. Your sign-in is kept. |
| `needs_auth` | The Keystone sign-in is missing or expired. | Run `oc_login`. |
| `port_busy` | Port 19876 (the sign-in callback), or 1459 for `{server: "synapse"}`, is in use, often by an OpenCode sign-in in another window. | Finish or close the other sign-in, then retry `oc_login`. |
| `policy_violation` | Something broke the rules: a non-Keystone MCP entry, changed permission rules, a wake for a session that is not yours, or an `always` answer. Nothing was sent. | Read the message. Run `oc_doctor`. Answer with `once` or `reject`. |
| `policy_unverified` | The bridge could not check the rules, so it refused. | Run `oc_doctor`, then retry. |
| `inbox_unavailable` | The inbox did not answer. This is never "no messages". | Run `oc_doctor`; retry after a box restart. |
| `cursor_expired` | The cursor is from before a restart or reset. | Call again without a cursor (after `oc_status`). |
| `not_found` | The session or request is not one of this bridge's, or it is gone. | `oc_list_sessions` or `oc_pending` for fresh ids. |
| `invalid_input` (model) | The model is not a Synapse model. | `oc_list_models`, then pick a `synapse/<id>`, for example `synapse/auto`. |
| `session_active` | `oc_close_session` was called on a session that is running or needs input; or any tool (`oc_send`, `oc_collect`, a second close) was called while a close of that session runs. | For a busy session: wait for it, or close with `abort: true`. While a close runs: wait for it to finish, then check `oc_list_sessions`. |
| `uncollected_work` | Closing would delete commits, uncommitted files or git-ignored files the host does not have. | `oc_collect` for commits; copy git-ignored files out by hand. Then close again. Or pass `discardWork: true` on purpose. |

Logs are JSON lines on stderr and in `<home>\logs` (default home `~/.local/share/opencode-delegate`, or `OPENCODE_DELEGATE_HOME`). They never contain secrets or message text.
