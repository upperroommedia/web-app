# Browser callable transport access

Firebase v2 browser callables need public **transport** invocation. Browsers send
an unauthenticated OPTIONS preflight; a private Cloud Run service rejects it
before Firebase's CORS middleware and token validation can run. This does not
replace Firebase Authentication, actor/role checks, App Check policy, admission
fences or request validation inside the callable.

The staging incident returned Google Frontend HTML 403 for `submitDurableJob`
and `getDurableJobReceipt`. The service IAM response was `{ "etag": "ACAB" }`.
The actual Firebase SDK already enabled callable CORS. Adding CORS middleware or
a client proxy would not repair the missing transport permission.

`scripts/temporal-callable-access.mjs` is a read-only gate, not a reconciler. Its
caller must first verify the immutable source endpoint manifest and deployment
source/revision evidence. Pass an explicit reviewed selection of browser
callables and the existing operator API callback:

- Binding: verified `projectId`, `projectNumber`, `runtimeCommit` from the release
  runtime/resource identity seam.
- Each selection: `functionId`, `region`, `codebase`, `sourceCommit`, the real
  endpoint declaration (`platform`, `entryPoint`, `callableTrigger`), exact
  deployed `service`, `revision`, `build`, and managed `source` generation.
- API: the existing authenticated `(url, method) => JSON` operator reader. The
  module issues only GET requests, never receives credentials and never calls a
  handler or changes IAM.

The gate joins each current ACTIVE Gen2 function to those source pins, reads its
exact service IAM policy, requires unconditional `allUsers` with
`roles/run.invoker`, then rechecks the function binding. It rejects HTTP, task and
event declarations instead of treating them as public browser callables. Its
report explicitly does **not** verify application authorization.

## Release integration

The release controller calls `verifyTemporalCallableTransport` before recording
`backend-ready` and again immediately before opening admissions. This narrow
path uses the existing verified runtime commit, resource project identity and
ownership flags, plus current authoritative Functions metadata. It requires
exactly one of each core browser callable: `submitDurableJob`,
`getDurableJobReceipt`, and `commandDurableJob`. Missing exports cannot silently
reduce coverage.

Each must be ACTIVE Gen2, labeled as a core callable, have the expected entry
point/commit/ownership flags, and map to a service in the verified project
(ID or verified number) and region. The gate reads only that exact service's
IAM policy, applies `assertPublicCallableTransport`, then re-reads the Function
to reject service/revision/build changes during verification. It neither
constructs an endpoint manifest nor claims a new source-provenance proof; the
controller retains its existing runtime/source checks. All reads use the
existing operator API. Failures leave admissions paused; no policy is changed.

The fuller `verifyBrowserCallableAccess` API remains available for callers that
already have independently verified immutable endpoint/build/source pins.
Module and actual-controller VM tests run under `test:temporal:contracts`.
Handler authentication and authorization remain enforced by the existing
callables, and transport verification explicitly does not claim to test them.

The deployed Firebase CLI 15.33.0 source sets callable public invocation in
`createV2Function`, but `updateV2Function` has no callable invoker repair branch
(`lib/deploy/functions/release/fabricator.js`). Thus an update alone does not
repair a missing binding. The origin of the missing policy is not established.
Any repair is a separately reviewed, exact-service CLI action. Never grant
public invocation globally or to private HTTP, task or event services.

Primary references: [Firebase callable protocol](https://firebase.google.com/docs/functions/callable-reference),
[Cloud Run functions CORS and authentication](https://cloud.google.com/run/docs/write-functions),
[CLI 15.33.0 implementation](https://github.com/firebase/firebase-tools/blob/v15.33.0/src/deploy/functions/release/fabricator.ts).
