---
status: awaiting_human_verify
trigger: "Investigate issue: pnpm-dev-live-startup-failures"
created: 2026-03-16T01:43:09Z
updated: 2026-03-16T02:10:00Z
---

## Current Focus

hypothesis: The repo-side fix is complete. The remaining work is user verification in a normal local shell to confirm the new preflight and strict stop behavior surfaces the real environment problem and that `pnpm dev` proceeds once Node 22 and local listener permissions are correct.
test: Have the user run `pnpm run dev:stop` and `pnpm dev` in their normal terminal with Node 22 active.
expecting: `dev:stop` should either clear ports or fail with the exact remaining listeners, and `pnpm dev` should fail immediately at `dev:preflight` until the shell can bind local sockets; after that, it should proceed into the normal build/start flow.
next_action: wait for human verification from the user’s real workflow environment

## Symptoms

expected: `pnpm dev` starts cleanly with usable frontend logs, emulator logs, and live reload for both Next.js and Firebase functions.
actual: The repo has had repeated stale-function and dev-run issues. We need to run the real dev command and fix whatever currently fails.
errors: Unknown until startup is observed live.
reproduction: From repo root, stop stale ports if needed, run `pnpm dev`, and inspect the first startup and watch/runtime failures.
started: Ongoing during current local development.

## Eliminated

- hypothesis: The first startup failure is caused by a bug inside the Next.js app or Firebase functions code itself.
  evidence: `next dev --hostname 127.0.0.1 --port 3100` fails with `listen EPERM`, and a trivial standalone Node HTTP server on fresh high ports also fails with `listen EPERM`, before any app code runs.
  timestamp: 2026-03-16T02:03:00Z

## Evidence

- timestamp: 2026-03-16T01:47:00Z
  checked: `pnpm run dev:stop` followed by `lsof -nP -iTCP:3000,4000,5001,8081,8123,9000,9099,9199 -sTCP:LISTEN`
  found: `dev:stop` reported success, but listeners were still present on 3000, 4000, 5001, 8081, 8123, 9000, 9099, and 9199.
  implication: The existing stop flow is misleading and allows stale processes to contaminate the next dev run.

- timestamp: 2026-03-16T01:50:00Z
  checked: real root `pnpm dev`
  found: `dev:prepare` completed, then `web` failed with `Error: listen EPERM: operation not permitted 0.0.0.0:3000`; `firebase emulators:start` also reported occupied ports (`9099`, `8081`, `9000`, `9199`) and EPERM bind failures on control ports including `4401`, `4001`, `4501`, and `9151`.
  implication: The first live blockers are port/listener setup failures, and the current root workflow wastes a full build before surfacing them.

- timestamp: 2026-03-16T01:54:00Z
  checked: direct `pnpm --dir apps/web exec next dev --hostname 127.0.0.1 --port 3100`
  found: Next failed with `listen EPERM` on a fresh alternate port.
  implication: The failure is not specific to port 3000 or the root concurrently setup.

- timestamp: 2026-03-16T01:56:00Z
  checked: standalone Node `http.createServer(...).listen(...)` on fresh high ports
  found: Node failed with `listen EPERM` for both `127.0.0.1` and `0.0.0.0`.
  implication: This shell environment cannot open local TCP listeners, so `pnpm dev` cannot fully run here regardless of app code.

- timestamp: 2026-03-16T02:00:00Z
  checked: repository scripts and helper files
  found: `scripts/preflight-dev.mjs` and `scripts/stop-dev-ports.mjs` exist, but root `package.json` still points `dev` directly at `dev:prepare` and keeps `dev:stop` on bare `kill-port`.
  implication: The smallest useful repo fix is still pending: wire the helper scripts into the root dev workflow.

- timestamp: 2026-03-16T02:05:00Z
  checked: `node scripts/preflight-dev.mjs` and `pnpm dev` under the shell's default Node runtime
  found: both fail immediately because the shell is on Node `24.13.0` while the repo requires Node `22`, and `.npmrc` has `engine-strict=true`.
  implication: Any valid local verification has to use Node 22 first; the repo already encodes that contract.

- timestamp: 2026-03-16T02:08:00Z
  checked: `zsh -lc 'source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && node scripts/preflight-dev.mjs'`
  found: the preflight failed immediately with `This environment cannot open local listening sockets (listen EPERM: operation not permitted 127.0.0.1)`.
  implication: On the correct runtime, the new preflight exposes the real environment-level blocker before any build or watcher startup.

- timestamp: 2026-03-16T02:09:00Z
  checked: `zsh -lc 'source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && node scripts/stop-dev-ports.mjs'`
  found: `kill-port` reported all target ports killed, but the script then failed and printed the remaining listeners still bound on the dev ports.
  implication: The strict stop check now catches the stale-process condition instead of silently pretending cleanup succeeded.

- timestamp: 2026-03-16T02:10:00Z
  checked: `zsh -lc 'source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm dev'`
  found: the root dev command now stops at `dev:preflight` with the local-socket `EPERM` message and never enters `dev:prepare`.
  implication: The repo-side change works as intended: startup now fails fast with the real cause instead of spending time on builds and noisy downstream crashes.

## Resolution

root_cause: The current shell environment cannot bind local TCP listeners and cannot reliably terminate existing listener owners, so Next.js and Firebase emulators fail before live reload can start. The repo also lacked a fail-fast preflight and strict stale-port verification, which hid the real cause behind a slow `dev:prepare` build cycle and misleading `dev:stop` output.
fix: Wired `pnpm dev` through `scripts/preflight-dev.mjs` before `dev:prepare`, and replaced the bare `kill-port`-based `dev:stop` with `scripts/stop-dev-ports.mjs` so startup now fails immediately on wrong Node/runtime or listener issues and cleanup now proves whether ports are actually free.
verification: Confirmed that the repo's default Node 24 shell now fails immediately on the declared Node 22 engine requirement; under Node 22, `node scripts/preflight-dev.mjs` fails fast on the socket-permission `EPERM`, `node scripts/stop-dev-ports.mjs` reports the still-bound listeners after kill-port, and `pnpm dev` aborts at `dev:preflight` before `dev:prepare`.
files_changed:
  - package.json
  - scripts/preflight-dev.mjs
  - scripts/stop-dev-ports.mjs
