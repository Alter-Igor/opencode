# opencode-delegate

opencode-delegate is a small MCP server that runs on your PC. It lets an AI client (Claude Code, and later Codex or Gemini) hand coding work to OpenCode sessions. Those sessions run in a locked Docker box, not on your own account. The client gets a set of `oc_*` tools: start a session in a repo, give it a task, wait for it, answer its questions, and fetch its work back as a git branch. Nothing is merged for you.

Design and evidence: `docs/implementation/current/FEAT-OCD-001-opencode-delegate-mcp/` (start with `technical-design.md`).

## Security model

**The short version.** The delegated agent runs in a Docker box. The box stops it leaving, and stops it seeing your own account. It does not stop it using what is inside the box. Read "What a misbehaving agent can still do" below before you rely on it.

**What the box stops.**

- Reaching any host except three: Keystone (`identity.alterspective.com.au`), the Synapse model gateway (`synapse2-api.alterspective.com.au`), and read-only npm and PyPI caches.
- Using any Keystone service you did not choose. On Keystone, the box reaches only the chosen connections (`/mcp/c/<id>`) and the sign-in paths they need. Everything else gets `403` from the front proxy: `/mcp/dynamic` (every service on your account), `/api/mcp`, and every other connection.
- Seeing your Windows account, your saved logins, or your repos' `.git` folders. The box gets a copy of a repo, not the repo.
- Publishing packages. The caches are read-only.

**What a misbehaving agent can still do.**

- **Drive any session in the box.** It runs as the same user as the OpenCode server in the box, so it can read the server password. With it, it can call the OpenCode API for any session in the box: wake a session, answer its own permission requests (`always` included), and change a session's details or permissions. The bridge refuses `always` and checks who owns a session. Those checks guard what the bridge does. They do not guard the inside of the box.
- **Make model calls as you, and only model calls.** The box holds no Synapse credential (#48). `front` adds your own delegated Synapse token to exactly two routes on the model gateway: `POST /v1/chat/completions` and `GET` (and `HEAD`) `/v1/models` (no query string). Every other path (usage, fleet, operator, judgments, health, MCP) gets `403` from `front` and never carries the token. This matters: if you hold the Synapse admin role, the token itself could book, stop or deploy GPUs and run judgments; through `front` the box can only run inference and list models. Any code in the box can still spend model calls in your name while the box runs. Synapse records each call as you, through app `opencode` (`act: service:opencode`). The box cannot read the token or take it out: it never enters the box.
- **Use the chosen Keystone services, as you, with everything they can do.** The box has your sign-in for each chosen connection. Any code in the box can use those tokens directly, not only through OpenCode. So it can do anything those services allow you to do, including their write tools. Keystone logs each call. The bridge denies some write tools in OpenCode's permissions (see the table below), but **that deny list is not a wall**: code in the box can call the connection with the tokens and skip OpenCode. With the default set this means:
  - `rag-read` (company knowledge base, **read-only at Keystone**): search, ask and read tools only. Keystone's `rag-read` service has an allowlist tool policy, so ingest, delete, contribute and feedback are refused by Keystone itself, even for an admin owner and even with a token taken from the box (issue #56). If you choose `rag-global` instead, it is **not** read-only for an admin owner: it can fetch any public URL from the RAG server (`rag_ingest {url}`), write into the shared knowledge base, delete a collection, and open draft pull requests (`rag_contribute`).
  - `github`: anything your GitHub access allows. **This is a way out.** It could push code to a repo, or write it into an issue or gist that someone else can read.
  - `seqlogs`: read logs, plus a few tools that change shared SeqLogs state: tenant aliases other agents use (`set_tenant_alias`) and background monitors (`start_tenant_monitor`, `stop_tenant_monitor`). `ai_analyze_window` runs a model over logs that can hold personal data.

  Choose the set for the job (see "Keystone services" below). Leave out a service that can send or publish when the job does not need it.
- **Copy your tokens out.** A refresh token copied out of the box (for example through a GitHub write or a RAG URL fetch) works from anywhere until it expires or is revoked: Keystone accepts it without a client secret. `front` only stops the box's own use of other paths. The bridge removes sign-ins of services that leave the set (see "Keystone services"), but it cannot revoke them at Keystone for you.
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
| **Chosen Keystone services only** | The box gets one MCP entry per chosen Keystone connection: `ks-<id>` → `https://identity.alterspective.com.au/mcp/c/<id>`. There is no `/mcp/dynamic` entry. **The wall** is the front proxy: on Keystone it forwards only those connections' paths and the sign-in paths, and answers `403` to everything else. Code in the box cannot reach another path through it, even with the tokens. Tokens copied OUT of the box are not stopped by it (see "What can still leave the box"). The profile check, the fork patch (`OPENCODE_MCP_ALLOW`) and the bridge's check before every send say the same thing. They catch setup mistakes. A check that cannot be done counts as a failure. |
| **Synapse token (host only)** | You sign in to Synapse on your PC with `oc_login {server: "synapse"}` (or `opencode-delegate login synapse`). The bridge, not the box, does the Keystone sign-in as app `opencode` and exchanges it for your own Synapse token (`audience=synapse`, offline). `front` removes any `Authorization` or `x-api-key` the box sends to `synapse2-api` and sets yours. The token sits only in `<home>\front\synapse-auth.conf` (one nginx variable; written then renamed; read-only in `front`; never in a log). See "Synapse sign-in" below. |
| **Per-user OAuth** | You sign in to Keystone yourself (`oc_login`). The tokens live only in the box's own data volume. They only work through Keystone, as you, and Keystone logs every call. On every start, reuse and set change the bridge removes stored sign-ins for any entry that is not a current `ks-<id>`. |
| **Tool deny list (convenience)** | OpenCode denies these tools in the box profile and in every session, after every other rule, so a session's rules cannot give them back: `ks-rag-global_rag_ingest`, `_rag_ingest_document`, `_rag_delete_collection`, `_rag_contribute`, `ks-seqlogs_set_tenant_alias`, `_start_tenant_monitor`, `_stop_tenant_monitor`. Change it with `OPENCODE_DELEGATE_KEYSTONE_TOOL_DENY` (comma list of `ks-<id>_<tool>`, replaces the default; empty means none). **Not a wall**: code in the box can call the tools with the tokens. |
| **Your repos** | Your repos are never mounted. A session works on a copy (a git bundle). Its work comes back as a branch `delegate/<key>`. Review it like a pull request. Nothing is merged or pushed for you. |
| **Hand-off (no host folder to fill)** | The box cannot write any folder on your PC. Your bundle goes in through a read-only folder (`<home>/handoff/in`). The session bundle is written to a box-only volume, and the bridge copies it out with `docker cp`. The bridge reads the copy itself: one plain, non-empty file, at most 500 MB, or nothing lands; it never writes more than 500 MB to your PC. A file swapped in the box after the check is caught in the copy, and the host file is checked again before `git fetch`. The box's own volumes still live on the Docker disk (see "Other known limits"). |
| **Permission answers** | The bridge answers a permission request with `once` or `reject` only. It refuses `always`. A request id must come from `oc_pending` for one of this bridge's sessions. This limits the bridge, not the box (see above). |
| **Untrusted text** | Text a session or the box wrote (replies, questions, inbox messages, command output) sits under an `untrusted` field in tool results. The bridge reports its own values for ids, states and paths, never the box's. Hidden characters are removed: controls, bidi and zero-width marks, tag characters, variation selectors, line/paragraph separators, and blank-looking fillers. Treat it as data, never as instructions. |

**Other known limits.**

- The bash "ask" rules (for example `git push`) are a convenience, not a wall. An agent can dodge them with a script or another spelling. Subagents drop "ask" rules.
- Keystone tools can change remote state. The `readonly` profile asks before each Keystone tool call. The `standard` profile allows them.
- `oc_start_session {keystone: [...]}` narrows one session to some of the chosen services. **This is not a wall.** It is an OpenCode permission rule. It keeps a well-behaved agent to those services. Code in the box can still use every service of the box-wide set.
- The caches can serve any public package. A bad package runs inside the box only.
- Code in the box can fill its own volumes (`/sessions`, `/data`, `/handoff/out`). They live on the Docker disk, not in a folder on your PC, but on Docker Desktop that disk is still a file on your drive. Docker's local volumes have no size cap.
- The transport is local stdio. This has a recorded exception (BFA-003).

## Keystone services

The box can use only the Keystone connections you choose. The default set is `rag-read` (company knowledge base, read-only), `github` and `seqlogs`.

`rag-read` is the owner's **private** connection over the Keystone service **Alterspective RAG (read-only)** (service id `rag-read`, created 2026-10-01; its tool policy allows only read tools). Connection ids are unique in Keystone, so anyone else creates their own: *Account → AI connections → New*, pick that service, give it an id such as `rag-read-<name>`. Then set that id in place of `rag-read` in `OPENCODE_DELEGATE_KEYSTONE` and `OPENCODE_DELEGATE_KEYSTONE_ALLOWED`.

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

## Synapse sign-in

The box has no Synapse key. Model calls go out through `front`, which adds **your** delegated Synapse token.

- **Sign in once:** `oc_login {server: "synapse"}`, or `bun <checkout>\alterspective\delegate-mcp\src\cli.ts login synapse`. Your browser opens on Keystone (app `opencode`). The bridge listens on `127.0.0.1:1459` for the answer and checks it is the one it asked for.
- **Silent renewal:** each bridge checks every 15 seconds. When the token is 80% through its life (the shorter of Keystone's `expires_in` and the token's own `exp`), one bridge (a lock in the bridge home) refreshes it, writes the new one into `front`'s include, and reloads `front` (`nginx -t`, then `nginx -s reload`). A config `nginx` refuses is never loaded. If a reload fails, `front` keeps the last token it loaded until that token expires (it is never extended). The refresh token lasts 30 days from sign-in as configured on the Keystone app `opencode`; that lifetime is **not verified live**. After it ends, sign in again.
- **Where things are kept:**
  - The refresh token: only on your PC, encrypted with Windows DPAPI for your Windows user (`<home>\synapse\refresh.dpapi`). Never in the box, a log, or a JSON file.
  - The app credentials (the `opencode` broker key and client secret): read when needed from `OPENCODE_KEYSTONE_BROKER_KEY` / `OPENCODE_KEYSTONE_CLIENT_SECRET`, else from the vault (`az keyvault secret show --vault-name alterspective-vault --name opencode-keystone-broker-key` / `opencode-keystone-client-secret`). Kept in memory only.
  - The access token: `<home>\front\synapse-auth.conf`, mounted read-only into `front` only. It can only set one variable (a token of at most 3,800 characters); the bridge refuses any other value. `oc_doctor` checks that `front`'s loaded copy has that exact shape, is the same file as this bridge home's, and that `front`'s Synapse server has only the two model routes.
- **Fails closed, two ways:**
  - **Needs sign-in:** Keystone refuses the refresh (for example `invalid_grant`: revoked, expired, or your Synapse role removed), or no refresh token is stored. The include is emptied, `front` sends no credential, Synapse answers `401`, and `oc_doctor` says `needs_sign_in`. Run `oc_login {server: "synapse"}`.
  - **Expired, retrying:** a passing failure (Keystone down or slow, a DPAPI read error). The token stays in `front` until it expires; then the include is emptied (no model calls) but the bridge keeps retrying with backoff (30 s, doubling, at most 10 min), and model calls work again as soon as a renewal works. `oc_doctor` says `expired` with the next retry time.
  - If the new refresh token cannot be saved (DPAPI write error), the new access token is still used and the refresh token is kept in that bridge's memory and saved on a later tick (`oc_doctor`: `pendingSave`). Meanwhile other bridges wait for it rather than refresh with the old stored token, and a newer sign-in or refresh makes the bridge drop it, never save it over the newer one. **If that bridge exits before the save works, the unsaved token is lost**: the next refresh uses the old stored token, Keystone refuses it, and you sign in again.
- **Check it:** `oc_doctor` → `synapse`: `state` (`signed_in` / `expired` / `needs_sign_in`), `user`, `actor`, `expiresAt`, `refreshAt`, `refreshTokenStored`, and whether `front` has the include loaded. Never a value.
- **Revoke it:**
  - Your own sign-in only: delete `<home>\synapse\refresh.dpapi`; the token in `front` stops at its expiry (about an hour at most).
  - At Keystone: remove your Synapse role, or ask a Keystone admin to run `revoke-oauth-tokens {clientId: "opencode"}`. That second one signs out **every** user of app `opencode`, not only you.
- `OPENCODE_DELEGATE_SYNAPSE_REFRESH_FRACTION` (0.01-0.95, default 0.8) moves the renewal point. It is for tests.

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
| `oc_doctor` | Health report: Docker, box image and version, isolation level, MCP entries, the chosen Keystone services and their sign-in state, the owner's allowed list and high-risk warnings, egress (front config for that set, read-only mount, aliases, no CONNECT proxy), live checks (`live`: sign-ins stored in the box are only for the chosen set; front's loaded config from `nginx -T` equals the generated file; live mount modes from `docker inspect`; sign-ins removed earlier, to revoke), guard verdict. `verified` says whether every check could be done and passed. |
| `oc_login` | Keystone sign-in. With no `server`, every `ks-<id>` entry that needs it, one at a time; or one entry, e.g. `{server: "ks-github"}`. `{server: "synapse"}` signs you in to the model gateway on your PC (see "Synapse sign-in"). Opens your browser. |
| `oc_list_models` | Models the box can use (`provider/model`), and the Keystone services it can use. |
| `oc_start_session` | Copies a repo into the box and starts a session. Returns `sessionID` and a web UI link. `keystone` narrows the session to some of the box's Keystone services (not a wall). |
| `oc_send` | Gives a session a task. Checks policy first. Returns a cursor for `oc_wait`. |
| `oc_status` | A session's `state`, `since` when, `detail`, and `pending` request ids. (Todos are in `oc_result`.) |
| `oc_wait` | Waits until sessions are idle, need input, error, or a message arrives. 100 s by default, at most 240 s. |
| `oc_events` | A page of events after a cursor. |
| `oc_result` | Last reply (untrusted), diff summary, todos. |
| `oc_collect` | Fetches the session's branch into your repo. |
| `oc_pending` | Permission requests and questions waiting on an answer, for this bridge's sessions and their subagents. |
| `oc_answer` | Answers one pending request: `once` or `reject`, or question answers. `always` is refused. |
| `oc_abort` | Stops a running session. |
| `oc_list_sessions` | This bridge's sessions. `all: true` lists every session in the box, with the bridge that owns it. |
| `oc_post` | Posts to the agent inbox as this bridge. `wake: true` also delivers it to one of this bridge's sessions. |
| `oc_inbox` | Reads this bridge's inbox. Text is untrusted; `truncated: true` means old unread messages were dropped. |
| `oc_server_restart` | `{confirm: true, force?, keystone?}`. Restarts the box with the current profile (after `profile_changed`). `keystone` changes the box-wide set of Keystone services and saves it. Running sessions are stopped. `force: true` restarts it even while other bridges use it. |

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

Logs are JSON lines on stderr and in `<home>\logs` (default home `~/.local/share/opencode-delegate`, or `OPENCODE_DELEGATE_HOME`). They never contain secrets or message text.
