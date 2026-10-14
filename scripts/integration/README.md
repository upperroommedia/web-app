# Search bootstrap Firestore integration

`temporal-bootstrap-search.firestore.integration.mjs` verifies the actual Admin SDK
query/transaction behavior of the paused-search bootstrap and real durable job store.
It is deliberately excluded from the default `*.test.mjs` suites.

From `web-app`, run this only in the team's reserved, serial emulator slot:

```sh
./scripts/with-node22.sh pnpm --dir functions exec firebase emulators:exec \
  --only auth,firestore,database,storage \
  --config ../firebase.test.json \
  --project urm-app-staging \
  "URM_SEARCH_BOOTSTRAP_EMULATOR_INTEGRATION=1 node --test --test-concurrency=1 ../scripts/integration/temporal-bootstrap-search.firestore.integration.mjs"
```

Do not run another `firebase emulators:exec` command in parallel. Do not point the
suite at dev emulators or manually export emulator hosts. The test reads the expected
Firestore and hub ports from `firebase.test.json`, requires exact loopback hosts,
explicit staging project and its integration opt-in before loading the Admin SDK.
It constructs the real Firestore SDK client with the validated loopback host and
`ssl:false`; the SDK supplies emulator authentication without Admin app credential
validation or Application Default Credentials.
There are no cloud, Algolia, Temporal server, secret, deployment or provider requests.

The staging project ID is needed for the actual bootstrap authority validation. All
fixtures live in a unique, named emulator database. Cleanup affects only the fixture
collections in that database; the default database and other test databases are not
modified. Emulator-generated multiple-database warnings are expected.

The serial regression verifies five job/intent/outbox/entity admissions, correct
workflow dispatch and generations, concurrent idempotent retries without timestamp
changes, rejection after operation/control replacement, the real transactional
`not-in` active-work query, durable store completion projection, final convergence,
and generation/authority compare-and-set rechecks. Applied settings receipts are
synthetic fixtures; this suite does not prove live provider settings or worker delivery.

A syntax check or expected refusal outside `emulators:exec` is not an integration
pass. Record the actual serial emulator execution result separately.
