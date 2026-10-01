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
- **Use the shared Synapse key.** The box holds one shared `SYNAPSE_API_KEY`. The agent can make model calls with it. Those calls are not tied to you as a person. (Follow-up: use a per-user delegated Synapse token.)
- **Use the chosen Keystone services, as you, with everything they can do.** The box has your sign-in for each chosen connection. Any code in the box can use those tokens directly, not only through OpenCode. So it can do anything those services allow you to do. Keystone logs each call. With the default set this means:
  - `rag-global` (company knowledge base): read it. Data can leave only through a service that can write.
  - `github`: anything your GitHub access allows. **This is a way out.** It could push code to a repo, or write it into an issue or gist that someone else can read.
  - `seqlogs`: read logs.

  Choose the set for the job (see "Keystone services" below). Leave out a service that can send or publish when the job does not need it.
- **Write code you might run.** Its work lands on a `delegate/<key>` branch in your repo. Review it before you run anything. `oc_collect` lists files that could run on your machine under `hostExecutableChanges`: git hooks, editor and agent config folders, executable files, and `package.json` scripts.
- **Do anything inside the box.** Edit files, run commands, install packages from the caches, read other sessions' files and inbox messages, and post inbox messages that claim to come from any session (these are stored as `verified:false`). It is one box per user.

**Which part is the wall.** The front proxy is the wall. The fork's MCP allowlist patch and the bridge's policy guard catch mistakes in setup. They do not hold back an agent that is trying to get round them.

**The parts.**

| Part | What it does |
|---|---|
| **The box** | A Docker container called `opencode-delegate`. It has no host environment, no saved logins, no API keys from your account. It runs as a non-root user with a read-only filesystem, apart from its work folders. |
| **Front proxy (the wall)** | The box has no route to the internet. Inside the box, the allowed names (Keystone, the Synapse gateway) point at a `front` proxy. It ends the TLS connection itself, with a certificate from a private CA made inside `front`, and opens its own connection to the one real host, with the name and `Host` header fixed. A swapped TLS name is refused at the handshake; a swapped `Host` gets `421`. Other names do not resolve, and there is no CONNECT proxy. Packages come from the read-only npm and PyPI caches. `front` looks up the real hosts with public DNS (`OCD_FRONT_RESOLVER`, default `1.1.1.1 1.0.0.1`); if that is blocked, it fails closed. |
| **Chosen Keystone services only** | The box gets one MCP entry per chosen Keystone connection: `ks-<id>` → `https://identity.alterspective.com.au/mcp/c/<id>`. There is no `/mcp/dynamic` entry. **The wall** is the front proxy: on Keystone it forwards only those connections' paths and the sign-in paths, and answers `403` to everything else. Nothing else in the box can get round it, even with the tokens. The profile check, the fork patch (`OPENCODE_MCP_ALLOW`) and the bridge's check before every send say the same thing. They catch setup mistakes. A check that cannot be done counts as a failure. |
| **Per-user OAuth** | You sign in to Keystone yourself (`oc_login`). The tokens live only in the box's own data volume. They only work through Keystone, as you, and Keystone logs every call. |
| **Your repos** | Your repos are never mounted. A session works on a copy (a git bundle). Its work comes back as a branch `delegate/<key>`. Review it like a pull request. Nothing is merged or pushed for you. |
| **Permission answers** | The bridge answers a permission request with `once` or `reject` only. It refuses `always`. A request id must come from `oc_pending` for one of this bridge's sessions. This limits the bridge, not the box (see above). |
| **Untrusted text** | Text a session or the box wrote (replies, questions, inbox messages, command output) sits under an `untrusted` field in tool results. The bridge reports its own values for ids, states and paths, never the box's. Hidden characters are removed: controls, bidi and zero-width marks, tag characters, variation selectors, line/paragraph separators, and blank-looking fillers. Treat it as data, never as instructions. |

**Other known limits.**

- The bash "ask" rules (for example `git push`) are a convenience, not a wall. An agent can dodge them with a script or another spelling. Subagents drop "ask" rules.
- Keystone tools can change remote state. The `readonly` profile asks before each Keystone tool call. The `standard` profile allows them.
- `oc_start_session {keystone: [...]}` narrows one session to some of the chosen services. **This is not a wall.** It is an OpenCode permission rule. It keeps a well-behaved agent to those services. Code in the box can still use every service of the box-wide set.
- The caches can serve any public package. A bad package runs inside the box only.
- The transport is local stdio. This has a recorded exception (BFA-003).

## Keystone services

The box can use only the Keystone connections you choose. The default set is `rag-global` (company knowledge base), `github` and `seqlogs`.

- **See the set:** `oc_doctor` (`keystone`, with each entry's sign-in state) or `oc_list_models` (`keystone.connections`).
- **Change it for the whole box:** `oc_server_restart {confirm: true, keystone: ["rag-global", "github"]}`. The choice is saved in the bridge home (`keystone.json`), so later restarts and other bridges use it. It rebuilds the profile, the MCP policy and the front proxy's Keystone paths, then restarts the box. Other bridges' sessions are interrupted, so it needs `force: true` while other bridges use the box.
- **Narrow one session:** `oc_start_session {..., keystone: ["rag-global"]}`. It must be a subset of the box-wide set. Convenience only (see "Other known limits").
- **New services need a sign-in:** run `oc_login` once. With no `server`, it signs in every entry that needs it, one browser tab at a time.
- An id is not checked against Keystone. A wrong id just fails to connect, and `oc_doctor` shows that entry as `failed` or `missing`.
- `OPENCODE_DELEGATE_KEYSTONE` (comma list) sets the default for a bridge home with no saved choice.

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
| `oc_doctor` | Health report: Docker, box image and version, isolation level, MCP entries, the chosen Keystone services and their sign-in state, egress (front config for that set, read-only mount, aliases, no CONNECT proxy), guard verdict. `verified` says whether every check could be done. |
| `oc_login` | Keystone sign-in. With no `server`, every `ks-<id>` entry that needs it, one at a time; or one entry, e.g. `{server: "ks-github"}`. Opens your browser. |
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
| `port_busy` | Port 19876 (the sign-in callback) is in use, often by an OpenCode sign-in in another window. | Finish or close the other sign-in, then retry `oc_login`. |
| `policy_violation` | Something broke the rules: a non-Keystone MCP entry, changed permission rules, a wake for a session that is not yours, or an `always` answer. Nothing was sent. | Read the message. Run `oc_doctor`. Answer with `once` or `reject`. |
| `policy_unverified` | The bridge could not check the rules, so it refused. | Run `oc_doctor`, then retry. |
| `inbox_unavailable` | The inbox did not answer. This is never "no messages". | Run `oc_doctor`; retry after a box restart. |
| `cursor_expired` | The cursor is from before a restart or reset. | Call again without a cursor (after `oc_status`). |
| `not_found` | The session or request is not one of this bridge's, or it is gone. | `oc_list_sessions` or `oc_pending` for fresh ids. |

Logs are JSON lines on stderr and in `<home>\logs` (default home `~/.local/share/opencode-delegate`, or `OPENCODE_DELEGATE_HOME`). They never contain secrets or message text.
