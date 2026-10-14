# Bundle bootstrap release proof

The application-owned command `scripts/temporal-bootstrap-bundles.mjs` is invoked by the release controller only during `--apply`, while private `_control/temporalRelease` has the matching release UUID and revision, global admission is paused, and bundles ownership is Temporal.

```sh
node scripts/temporal-bootstrap-bundles.mjs \
  --project urm-app-staging \
  --release-id <release-uuid> \
  --control-revision <revision> \
  --apply
```

Use the repository's supported Node runtime and install frozen workspace dependencies first. `--help` loads no Firebase modules. `--timeout-ms` optionally selects 1 second through 1 hour; the default convergence budget is 20 minutes. The executable rejects inherited emulator settings and pins all shared Firebase service selectors to the supplied reviewed project. It loads current application TypeScript using the installed `ts-node` and `tsconfig-paths`, rather than deploying stale compiled output.

Six deterministic, release-scoped bundle regeneration intents are submitted through the trusted server bridge: topics, subtitles, bible-chapters, sunday-homilies, holy-week, and latest-list. The trusted `expectedReleaseControl` argument fences the UUID and revision in the admission transaction. `continuation:true` permits this internal release operation during the admission pause; browser requests cannot access this bypass.

Success requires the newest active entity generation to have a succeeded bundle job, an exact matching private `_durableBundlePointers` generation/job ID, and an immutable Storage artifact with a nonempty byte count, expected content type, and the same bundle document count. A final Firestore transaction rechecks the control revision and the entire set of active generations/pointers after Storage checks. A concurrent newer event may supersede an initial bootstrap job: its successful current generation is valid proof, provided it is at least the admitted bootstrap generation. Pointer movement during artifact inspection causes another convergence pass.

Standard output contains only a JSON object with `projectId`, `releaseId`, `controlRevision`, `result:'passed'`, the six `bundleTypes`, current successful `jobIds`, and original `bootstrapJobIds`. Diagnostics expose fixed error codes only. A timeout or revision mismatch does not open admission or cancel already-admitted work; rerun the same paused release command to recover deterministic receipts. The controller must validate the returned release/project/revision and six types before recording `bundlesConverged:true`.

Pure tests: `node --test scripts/temporal-bootstrap-bundles.test.mjs`. No production command or provider write was used to validate the implementation.

## Exhausted bootstrap jobs: reviewed replacement generations

A pending timeout and an exhausted workflow are different cases. Rerunning the original bootstrap recovers its deterministic receipts; it does **not** resurrect a terminal failed job. Browser commands reject terminal retries, and a direct Temporal reset/start would bypass the application admission and leave failed application metadata. Preserve those original jobs, intents, receipts, outboxes, pointers and immutable artifacts.

Use the committed `scripts/temporal-recover-bundle-bootstrap.mjs` operator command only after diagnosing and repairing the underlying problem, verifying current worker health and authenticated read access, and checking actual Temporal closure plus exact worker execution-drain witnesses. It supports initial-cutover releases at `backend-ready`, with all selected owners Temporal and all admissions paused. It never opens admission, changes a release checkpoint or publishes to a provider.

Inspect first, supplying the actual private control revision and a new private output path:

```sh
node scripts/temporal-recover-bundle-bootstrap.mjs inspect \
  --release /private/release.json --control-revision 11 \
  --runtime-root /reviewed/immutable/runtime-checkout \
  --output /private/recovery-inspection.json
```

`--runtime-root` defaults to this checkout. An older frozen runtime can be selected explicitly: its actual HEAD must equal the descriptor's compatibility commit, committed API source/locks must match, and its normal immutable-source guard must pass. The new operator's own committed source identity is recorded separately; it is not relabelled as the old runtime. Neither checkout may be patched to bypass a check. `--help` is offline; real commands refuse inherited emulator overrides. Install normal frozen dependencies before running; the tool never installs or updates dependencies.

After independent review of actual observations, `apply` additionally requires `--reason` (at least ten characters) and `--evidence-reference`. It verifies the actual ADC Google principal with the official Google SDK's Bearer-header POST tokeninfo request, and target-project IAM enforces acquisition of a nonexpiring release operation. The audit records the ADC identity and, when available, the active gcloud account; different or unknown identities remain explicit. No Firebase Auth UID or external CloudEvent identity is invented. `system:firebase-event` is the existing **shared trusted server principal** used by bundle admission; this operation is explicitly operator release recovery, not a fabricated Firebase event.

Acquisition transactionally checks the actual release UUID, revision, phase, paused owners, native cutoff/control/state identity, six original failed bootstrap admissions and current generation, absent competing operation, and current exact execution-settlement witnesses. Execution heads have no liveness TTL: only their matching worker-settled drain witnesses establish settlement. The bounded latest-head check is not a substitute for Temporal pending-activity or graceful-worker evidence.

The immutable recovery plan derives each replacement request ID from project, release, original failed job ID and generation. It calls the **unchanged runtime's** `submitServerDurableJob` with the predefined bundle type, server continuation, `expectedGeneration`, and `expectedReleaseControl`. The server's admission transaction creates the new generation/job/intent/outbox/receipt and checks the release and generation fences. It does not rewrite the old failed job. Existing receipt/input hashes are checked before submission; a legitimate newer active/succeeded generation is respected rather than overwritten. A failed or unbound newer generation requires fresh review.

The command never silently retries an ambiguous submission. A failure after acquisition retains its exact nonexpiring operation and immutable plan. Inspect actual state, then use explicit `resume` with the same `--recovery-id` and `--operation-id`, plus reason/reference and fresh output. Resume verifies the original plan/runtime/authority and reconciles existing deterministic application receipts before admitting only missing replacements. It never steals an expired guard, generates random replacement request IDs or clears another operation. A failed replacement requires another explicit reviewed recovery design; rerunning this plan cannot manufacture another generation.

The final transaction creates a separate immutable **admissions-verified** result and deletes only its own exact operation. It does not assert that jobs succeeded or bundles converged. The old server API does not read the operator nonce: safety combines the nonexpiring cooperating release lock with the server's atomic UUID/revision/generation fences; there is no claimed cross-module transaction. After actual verified recovery admissions, invoke the normal release controller's `bootstrap-bundles` again. Its unchanged convergence loop can accept a newer successful generation while retaining the original bootstrap receipts and checks actual artifacts/pointers before advancing.

Use fresh private logs/output paths and preserve actual failure status. Raw credentials, access tokens, HTTP client configurations and provider errors are never diagnostic output. If audit or final response acknowledgement is uncertain, inspect the actual immutable result and operation rather than retrying or manually changing jobs, release state or pointers.

Validation: `node --test scripts/temporal-bundle-bootstrap-recovery.test.mjs`. The dedicated emulator adapter test is `scripts/tests/temporal-bundle-bootstrap-recovery.firestore.test.mjs`; run it only through `firebase emulators:exec --only auth,firestore,database,storage --config ../firebase.test.json`, never dev emulators. `BUNDLE_RECOVERY_TEST_RUNTIME_ROOT` may select an unchanged reviewed runtime for this test. Its locally generated synthetic certificate is valid only for the explicit emulator harness; it uses no live operator credential or recovery API.
