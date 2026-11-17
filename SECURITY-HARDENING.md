# Security hardening — draft

This fork is **not yet approved for production deployment**. Changes below are proposed fixes awaiting a passing CI run, integration tests on a disposable Matrix homeserver and a security review.

## Changes

- Shell-unsafe single-string tmux command removed; the Claude command and arguments are provided separately. Explicit session names are restricted to a safe character set.
- Local relay HTTP endpoints, including health and SSE, require a bearer token derived per Claude session using HMAC-SHA256. Health verifies the expected session ID.
- Local supervisor handoff endpoints require a separate on-disk bearer token with private file permissions and reject oversized request bodies.
- Port allocation treats spawning sessions as occupied and does not reuse stale ports when resuming a detached session.
- Remote text permission approvals require `approve <request-id>` / `deny <request-id>`, and reaction approvals check the owning session.
- Claude project trust confirmation is no longer automated; bypassPermissions is rejected.
- New Matrix rooms are created with encryption state, the bot has a persistent crypto store, and existing plaintext rooms are rejected. Task data is no longer posted as Matrix room-topic state.

## Setup

Run the bridge under a dedicated **unprivileged user** (preferably in an isolated VM), with filesystem access only to explicitly permitted repositories. Do not run it with sudo or give it broad control of the Proxmox host.

Run `mise run setup` and edit `.env` with Matrix credentials plus a real existing project directory. Set:

```dotenv
MATRIX_ENABLE_E2EE=true
CMB_ALLOWED_WORKDIR_ROOT=/home/bridge/projects
```

`mise run setup` generates a 32-byte `CMB_RELAY_SECRET` in `.env` and a 0600 local handoff token at `~/.config/claude-matrix-bridge/handoff-token`. Keep these private. Back up `packages/supervisor/data/bot-crypto` together with `bot-sync.json` and the associated bot credentials.

Use a **new bot Matrix device and new encrypted rooms**. Existing unencrypted rooms are deliberately refused; the default bot's old room IDs in SQLite may require migration/reset.

## Required verification

1. `cd packages/supervisor && npm ci && npx tsc --noEmit && npm test`.
2. `cd packages/matrix-relay && bun install --frozen-lockfile && bunx tsc --noEmit`.
3. Install the exact lockfile versions in a disposable VM and run `npm audit --omit=dev --audit-level=high`; audit `bun.lock` and update `@modelcontextprotocol/sdk` with a regenerated lockfile.
4. Confirm every relay endpoint rejects wrong/missing tokens and `/health` rejects another session ID.
5. Create two sessions concurrently and ensure no shared port or cross-room replies/approvals.
6. Verify encrypted room messages are decrypted after restart, and device verification/key backups are correct.
7. Check tmux interactive trust, room permissions, remote denial, session resume and handoff.
8. Attempt shell metacharacters in manual session names, and symlink escapes outside the allowlisted workdir.

## Remaining risks

**E2EE is not a sandbox:** decrypted source and approval previews are available to the bot and its OS user. Encryption cannot protect Matrix room state such as names, topics, parent/child relationships or pinned-event IDs. A malicious process running under the same Unix user may inspect process metadata or compromise the relay; use a dedicated OS identity/VM and filesystem boundaries.

**Device verification must be checked manually.** Creating encrypted rooms does not itself prove the owner is talking to a verified bot device. The Matrix server can see routing metadata. Existing exposed plaintext chat history cannot retroactively become encrypted.

**Dependency refresh is pending.** Relay `bun.lock` retains its pinned MCP SDK version pending an online `bun update` and lockfile review. Do not claim the full dependency-audit finding is closed.

**Claude can execute project code.** Approving Bash and development hooks can execute arbitrary code with the Claude OS user's privileges, regardless of this bridge's permission checks.

This is not a formal penetration test. The branch is intended for review and iterative CI fixes.

## Dependency audit gating (2026-11-17)

The dependency audit identified **16 production vulnerability records (3 critical, 5 high, 8 moderate)**, including an unsupported `request` / `request-promise` dependency chain pulled in by `matrix-bot-sdk`. Several have no patched version. Because a full Matrix SDK migration is required to eliminate those, CI now uploads the complete `npm audit` JSON artifact, prints a prominent warning, and **fails on newly vulnerable packages or increased severity counts compared with the audited baseline**. Passing CI does **not** indicate dependencies are secure. Do not merge or deploy while critical findings remain unremediated.
