# Upper Room Media Web App

## Prerequisites

- Node `22` (see `.nvmrc`)
- `pnpm`

Use:

```bash
nvm use 22
pnpm install
```

## Local Development

Run the app:

```bash
pnpm dev
```

This starts the web app and local Firebase emulators used by the project workflow.

## Firebase Functions Codebases

Functions are split into isolated Firebase codebases to reduce cold-start load:

- `functions-core`
- `functions-media`
- `functions-image`
- `functions-integrations`

Each codebase builds independently and is wired in `firebase.json`.

Build all codebases:

```bash
pnpm build-functions-codebases
```

Run startup-load guard (checks that `core` does not load heavy/media/client-sdk deps at module load time):

```bash
pnpm check:function-startup-loads
```

## Local Functions Test Examples

Converter-focused test with Firestore emulator:

```bash
cd functions
pnpm exec firebase emulators:exec --only firestore --config ../firebase.test.json "pnpm exec jest src/test/firestoreDataConverter.test.ts --runInBand"
```

Full functions tests that need auth + firestore:

```bash
cd functions
pnpm exec firebase emulators:exec --only firestore,auth --config ../firebase.test.json "pnpm exec jest --forceExit"
```
