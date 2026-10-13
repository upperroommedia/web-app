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
