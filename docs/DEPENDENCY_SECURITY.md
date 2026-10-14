# Dependency security maintenance

Use Node 22 for dependency resolution, production startup checks, and application builds. Regenerate deployment locks through `node scripts/functions-npm-locks.mjs generate`; deployment checks must validate tracked locks and must not resolve newer packages.

The dependency follow-up based on release `8f519c6` has a clean production workspace audit. The three kit production npm locks remain unchanged and separately audit clean. Run `pnpm audit --prod` again when reviewing or releasing changes; these results are a snapshot, not a permanent guarantee.

The production changes are:

- Storage's supported `fast-xml-parser` 5.11.2 replaces the obsolete global 4.5.7 constraint. The real Storage multipart implementation is tested with its XML requests captured at a fake transport boundary.
- Palette extraction uses bounded Sharp RGBA samples and the official Vibrant quantizer and generator. Jimp and its vulnerable file-type parser are removed. Existing image decoding limits remain. Original solid-color, mixed-color, and gradient fixtures match; Sharp and Jimp can interpolate other image edges slightly differently.
- Audio logging uses LoggingWinston 7.3.0 on Node 22. Its actual production logger construction, severity, labels, context, error stack, and completion are tested without network access. Both asynchronous transport errors and SDK diagnostic-write failures reach a shared nonrecursive fallback. It writes a fixed notice to stderr at most once per minute with at most one outstanding write, excludes provider error payloads, and tolerates stderr failure. A real application subprocess verifies that failed remote delivery preserves the original console error severity and lets business processing continue without an unhandled error or rejection.
- CloudEvents uses a narrowly scoped UUID 11.1.1 override, which retains CommonJS support. A global upgrade to an ESM-only UUID major would break unrelated CommonJS consumers.
- get-uri uses a narrowly scoped basic-ftp 6.2.3 override. The upstream secure transfer-host default is preserved and tested with a real loopback FTP transfer.

The scoped policies are translated into npm overrides for standalone Functions uploads. Validation follows the actual dependency graph, including hoisted packages and scoped namespace lookup paths. Required missing edges, mismatched versions, and unsupported selector grammar fail deployment checks. Unrelated dependency versions remain independently resolved.

`pnpm run test:temporal:contracts` builds the real audio application and its workspace dependencies on Node 22 before running these runtime dependency contracts. The prerequisite uses the declared Turbo dependency graph and output caches; clean-output restoration is verified against the actual emitted files. The tests never contact cloud or publishing providers. The loopback FTP fixture is synthetic and owns both endpoints.

## Remaining development-only advisories

The full workspace audit still reports five advisory IDs in tooling. They are not production runtime dependencies in the audited lockfile. Do not suppress them or describe the full audit as clean.

| Dependency                | Tooling path                                | Current limitation                                                                                                                   |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| braces 3.0.3              | Next ESLint / glob tooling and CLI watchers | High advisory GHSA-vfj7-8cjw-p6xm; no patched stable release was available at review.                                                |
| UUID 9.0.1                | Firebase CLI / older Google Auth transport  | Moderate GHSA-w5hq-g745-h8pq; a blanket UUID override is not justified by the tested CloudEvents fix.                                |
| ts-deepmerge 2.0.7        | firebase-functions-test                     | Moderate GHSA-87mf-gv2c-c62c; latest test harness still declares v2. A migration to v8 needs separate harness behavior verification. |
| OpenTelemetry core 1.30.1 | Firebase CLI / PubSub                       | Moderate GHSA-8988-4f7v-96qf; do not force core v2 into an unverified v1 SDK graph.                                                  |
| sprintf-js 1.0.3          | Jest / coverage configuration tooling       | Moderate GHSA-hp3w-g68c-fv3c; no patched stable release was available at review.                                                     |

Prefer supported parent upgrades and migration tools. If an upstream release still requires a vulnerable major, test a narrowly scoped replacement or remove the unnecessary dependency rather than applying an incompatible global override.
