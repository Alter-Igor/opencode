# FEAT-OCD-001 — Tasks and checklist (revision 2: Docker sandbox, Option A-S)

Each task is 50–200 LOC, under 2 hours, and ends in something that can be checked. `[ ]` = not started. Nothing is started.

## Wave 0 — spikes (CAPABILITY-HUB, serial)

- [x] **T0.1 Box + egress spike** (PASS — `evidence/wave0-spikes.md`) — HUB · Deliverable: throwaway compose with the fork image, `C:\GitHub` → `/work` mount, internal network, egress proxy allowing only `identity.alterspective.com.au` + one model host · Verification: from an agent shell inside the box `curl https://rag.alterspective.com.au` is refused and `curl https://identity.alterspective.com.au` succeeds (red then green); `GET /mcp` shows only the profile entries; `bun install` + `bun test` timing on a small repo recorded · LOC ~120 · Rules: BFA-007, TST-FAL-01
- [x] **T0.2 Token-race spike** (live PASS 2026-10-01: 3 directories, 1 rotation, 0 invalid_grant) (unit-level PASS with the real SDK: 0 refresh-token reuses in 25 runs, mutation red; live 3-directory run moved to T1.2 once the fork image exists) — HUB · Deliverable: 3 directories, `ks-delegate` with an expired access token, concurrent tool calls · Verification: without the patch, record whether Keystone returns `invalid_grant` (evidence note); with T0.4 it must not · LOC ~60 · Rules: BFA-004
- [x] **T0.3 OAuth-from-box spike** (PASS — `evidence/wave0-spikes.md`) — HUB · Deliverable: `ks-delegate` sign-in initiated by the bridge, browser on host, callback reaching the box (bind `0.0.0.0` in box, or relay `code` to `POST /mcp/:name/auth/callback`) · Verification: `GET /mcp` → `ks-delegate: connected`; a `search-tools` call succeeds; Keystone audit shows the owner · LOC ~60 · Rules: BFA-004, BFA-005, AILES-024
- [x] **T0.4 Fork MCP patch** (done: 116 LOC + tests; `bun test test/mcp` 87 pass / 0 fail, baseline 61/0; mutation checks red; see `evidence/wave0-spikes.md`) — HUB · Deliverable: `OPENCODE_MCP_ALLOW` enforcement in `MCP.create`/`MCP.add`; `type`/`url` in `GET /mcp`; single-flight refresh per entry in `mcp/oauth-provider.ts`; fork note in `AGENTS.md` · Verification: new tests in `packages/opencode/test/mcp/` seen red then green; upstream behaviour unchanged when the env var is unset; ≤150 LOC · Rules: BFA-007, TST-FAL-01/02

**Kill-criteria check after W0** (`plan.md` §5). Stop and report to the owner if any is hit.

## Wave 1 — MOD-01 + MOD-02 (built + reviewed + fixed; live e2e PASS `evidence/wave1-e2e.md`; verification review done; fixes `0d7407fb4f`; e2e re-run PASS) — **WAVE 1 COMPLETE**

- [x] **T1.1 Profile builder** — MOD-01 · Deliverable: profile dir from owner `provider`/`model`/`small_model` (`{env:}` refs only), allowlisted MCP, permission baseline; approved env-var list · Verification: unit tests incl. literal-key refusal (red first) · LOC ~150 · Rules: ASR-04, SECURITY :517
- [x] **T1.2 Image + compose** — MOD-01 · Deliverable: `Dockerfile` (fork + patch, pre-installed plugin deps, toolchains), compose for box / egress / inbox, image tag with SHA · Verification: `docker compose config` valid; image runs `opencode --version` · LOC ~150 · Rules: VER-BUILD-02, ARCH-ASSESS-01
- [x] **T1.3 Start / reuse / stop** — MOD-01 · Deliverable: container-name lock, password in memory + container env, published `127.0.0.1` port, health poll, lease-based stop · Verification: two bridges race → one box; last lease stops it; no process-class kills (AILES-026) · LOC ~150 · Rules: CLI-UX-20
- [x] **T1.4 Workspace manager (bundles)** — MOD-01 · Deliverable: bundle in → clone in `/sessions/<id>` on branch `delegate/<id>`; bundle out → host `git fetch` into the owner's repo; root check (`C:\GitHub`, `X:` subst) · Verification: round-trip on a scratch repo; red test: a poisoned hook in the clone never runs on the host during fetch · LOC ~150 · Rules: SECURITY :517
- [x] **T1.5 `oc_login` flow** — MOD-01 · Deliverable: productionised T0.3 · Verification: runtime sign-in; `needs_auth` → `connected` · LOC ~70 · Rules: BFA-004, BFA-005
- [x] **T2.1 Allowlist validator** — MOD-02 · Deliverable: pure function per `technical-design.md` §3.2 · Verification: direct URL, header, `http://`, look-alike host, `/api/mcp`, `oauth.clientSecret`, `redirectUri`, local type → all refused (seen red) · LOC ~80 · Rules: BFA-007, MCP-CONSUME-01
- [x] **T2.2 Runtime guard** — MOD-02 · Deliverable: `GET /mcp?directory=` URL/type check before each send; 15 s poll for busy dirs; `policy_unverified` on failure · Verification: fake server tests; runtime `POST /mcp` of a direct server → refused by patch, and guard aborts if it ever appears · LOC ~90 · Rules: SECURITY :832
- [x] **T2.3 Egress allowlist + registry caches** — MOD-02 · Deliverable: proxy config from the approved host list (default deny); npm + PyPI pull-through caches with publish disabled; the box reaches registries only through them · Verification: T0.1 red/green cases automated; `npm publish` from the box refused; `npm install` works · LOC ~120 · Rules: BFA-007
- [x] **T2.4 Permission baseline + folder rule** — MOD-02 · Deliverable: rulesets in profile and per session; never send `tools`; re-read `session.permission`; `directory_busy` · Verification: unit + integration · LOC ~90 · Rules: ETHICS-AGENT-02

## Wave 2 — MOD-03 + MOD-05

- [ ] **T3.1 SSE client + normaliser** — MOD-03 · LOC ~120 · Verification: fixture replay · Rules: OBS-ID-01
- [ ] **T3.2 State machine + absent states** — MOD-03 · LOC ~150 · Verification: one test per absent-state row (`technical-design.md` §6) · Rules: TST-VAL-01
- [ ] **T3.3 Reconnect + rebuild** — MOD-03 · LOC ~100 · Verification: kill stream mid-task; state recovers
- [ ] **T3.4 Watch CLI** — MOD-03 · LOC ~90 · Verification: run under Claude Code Monitor; lines arrive · Rules: CLI-UX-06, -07, -20
- [ ] **T3.5 Channel push (optional)** — MOD-03 · LOC ~60 · Verification: manual; else recorded "not verified"
- [ ] **T5.1 Inbox sidecar** — MOD-05 · Deliverable: Bun HTTP service, own volume, admin token for bridges only (box posts stored `verified:false` with the claimed sender — inside the box a sender cannot be proven), hop/rate/size limits counted by the sidecar · Verification: box cannot forge `verified:true` or read supervisor inboxes; admin needs the token; loop bounded by rate limits (hop limit per thread) · LOC ~150 · Rules: ETHICS-AGENT-03
- [ ] **T5.2 In-box tools** — MOD-05 · Deliverable: profile `tool/message_supervisor.ts`, `message_session.ts`, `read_inbox.ts` calling the sidecar · Verification: a session calls each; records appear · LOC ~100

## Wave 3 — MOD-04 + hub

- [ ] **T4.1 Tool skeleton + doctor/list tools** — MOD-04 · LOC ~150 · Verification: MCP Inspector lists tools with schemas · Rules: MCP-STANDARDS :1232-1275
- [ ] **T4.2 Session tools** — MOD-04 · LOC ~180 · Verification: real model on a scratch repo
- [ ] **T4.3 Wait / events tools** — MOD-04 · LOC ~100 · Verification: timing; `still_running`
- [ ] **T4.4 Pending / answer tools** — MOD-04 · LOC ~90 · Verification: round-trip; `always` refused (red first) · Rules: MCP-STANDARDS :707
- [ ] **T4.5 Output shaping + untrusted fencing** — MOD-04 · LOC ~80 · Verification: injection string stays in `untrusted` · Rules: ETHICS-AGENT-01
- [ ] **T4.6 Hub wiring, versioning, logging, E2E** — HUB · LOC ~200 · Verification: E2E transcript for F1–F5 in `evidence/`; secret scan inside the box and over logs/results · Rules: VER-*, OBS-SNK-01 (D-1), DOC-MOD-01

## Review rounds (every wave)

- [ ] Round 1 logic · [ ] Round 2 typecheck + lint (paste output) · [ ] Round 3 edge cases · [ ] Runtime test · [ ] #41 checkpoint

## Before PR

- [ ] Fork test baseline (`bun test` in `packages/core`, `packages/opencode`) vs the `dev` baseline (`AGENTS.md:165`)
- [ ] Adversarial round 2 (design) done; round 3 on the final diff (QUA-001-53)
- [ ] F6 Keystone audit evidence, or "not verified" stated
