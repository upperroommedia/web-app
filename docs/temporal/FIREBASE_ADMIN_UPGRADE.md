# Firebase Admin and Google service clients

The application now uses Firebase Admin 14.5.0 through the supported modular entry points. The configured application service modules retain only `app`, `auth`, `firestore`, `database`, and `storage` accessors. SDK types and static Firestore utilities are imported from their individual modules. This preserves one configured Firebase application without recreating the removed legacy Admin namespace.

The migration follows [Firebase's modular Admin migration guide](https://firebase.google.com/docs/admin/migrate-node-v10) and [Admin release notes](https://firebase.google.com/support/release-notes/admin/node). Firebase CLI help was checked first; it exposes no source migration command for this change, and the published SDK exposes no migration executable.

Google Auth 11.2.0 and Google Cloud Storage 8.4.0 require Node 22 or newer. Runtime images use Node 22. Their installed versions are controlled by the workspace dependency catalog and lockfile.

## Token transport workaround

Google Auth 11 incorporates JWT token exchange internally and no longer depends on the external `gtoken` package. The prior Docker patch to one hardcoded `gtoken` file would therefore fail during an upgrade and would miss nested SDK copies.

`apps/process-audio/scripts/patch-google-oauth-transport.cjs` applies the existing identity-encoding workaround to supported installed token exchange implementations after production dependencies are assembled. It covers both modern Google Auth exchanges and transitive legacy `gtoken` copies, handles hoisted and pnpm layouts, is idempotent, and fails the image build if an exchange implementation changes unexpectedly. Only Google token exchanges are changed; provider traffic remains governed by its separate relay adapters.

This workaround prevents the previously observed truncated compressed OAuth responses on the Hetzner egress path. It should be removed only after the underlying transport problem is independently reproduced as fixed on the serving network.

## Validation

On Node 22, `test-google-oauth-transport.cjs` exchanges a locally generated signed JWT through a local HTTP token server, verifies identity encoding and grant contents, and confirms token reuse. It also verifies idempotency and rejection of unknown implementations. The provider relay regression test passes without changes to its authentication or route restrictions.

The shared configured service bootstrap resolves Auth, Firestore, Realtime Database, and Storage with Admin 14.5.0 using emulator-only configuration without performing network writes. Functions, process-audio, and browser-fallback TypeScript checks pass with the upgraded clients. Emulator-backed application tests remain coordinated through the repository's dedicated `firebase.test.json` harness.

## Functions test companion compatibility

The latest upstream `firebase-functions-test` 3.5.0 still uses the removed legacy Admin namespace and declares peers only through Admin 13. The repository therefore carries an explicit, versioned compatibility patch created with `pnpm patch` and committed with `pnpm patch-commit`; this is a local adaptation, not upstream Admin 14 support.

The patch converts runtime and declaration imports to modular entry points, returns the asynchronous application cleanup operation, and updates Firestore class checks. It also honors the documented `firebaseApp` snapshot option and encodes document references using their current SDK project/database identities and complete resource paths. The same Admin SDK supplies both application objects and test snapshots, avoiding incompatible classes from a second installed major version.

`functions/src/test/firebaseFunctionsTestCompat.test.ts` exercises current SDK snapshot values, explicit application identity, consecutive awaited cleanup cycles, and a wrapped callable that writes to the dedicated test emulator. Run it only through `firebase emulators:exec --config ../firebase.test.json` with other emulator suites serialized. Remove the patch when a verified upstream release supports the modular Admin runtime and these regressions pass without it.
