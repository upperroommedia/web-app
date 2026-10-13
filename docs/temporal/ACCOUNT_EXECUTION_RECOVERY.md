# Recovering an account activity after a worker crash

An interrupted Firebase Auth claims update or session revocation remains locked to its original account request. A timeout, elapsed lease, newer activity attempt, restarted container, or deleted pod does not establish that the original worker stopped. The system keeps the operation in review and blocks competing account changes.

Normal workers write a private completion witness only after their real provider promise settles. The recovery tool is for a crash that prevented that witness. It writes evidence that the exact originating worker has terminated; it does **not** update Auth, complete the account receipt, resume a workflow, or change the public job projection.

## Required evidence and access

Use the concrete environment descriptor deployed by the Temporal platform tools. Staging and production have separate Firebase projects, Temporal namespaces, Kubernetes namespaces, and physical cluster identities. The recovery tool checks the descriptor against the recorded execution and live `kube-system` namespace UID.

Automatic receipt release additionally requires the resource's recorded `transport: single_shot_identity_toolkit` for claims, or `sessionTransport: single_shot_identity_toolkit` for sessions. The account setter uses a single explicit Identity Toolkit request, without the Admin SDK's automatic mutation retries. A historical SDK mutation can have multiple ambiguous remote requests; worker termination alone cannot make that case safe to release.

For `--phase claims` (the default), the private account resource must still be `state: started`, owned by the same job and target UID, with the same frozen claims, `execution` identity, and current generation. For `--phase sessions`, it must instead have `state: applied`, `sessionState: started`, a frozen UUIDv4 `sessionOperationId`, matching `temporalAccountSessionOperationId` in the complete `sessionClaims` payload, a valid frozen `sessionCutoffSeconds`, and its own `sessionExecution` identity for `revokeAccountSessions`. The tool never substitutes the earlier claims execution for the session execution. Its recorded worker identity includes the process instance, immutable build, pod UID, node UID, namespace, cluster identity, and exact container IDs. Incomplete historical identities cannot be reconstructed by typing new values into this tool.

The operator needs read access to the originating pod, namespace, node, and live kubelet container inventory through the authenticated API-server node proxy, plus private Firestore access to the account resource, job, intent, entity, drain witness, and audit collections. `nodes/proxy` is a privileged Kubernetes permission; keep it on the restricted operational identity rather than the application worker account. The script obtains the Kubernetes operator through `kubectl auth whoami` and the Google operator's immutable subject through verified OAuth token information. There is no caller-supplied operator identity.

The exact pod object must remain available with a terminal phase and complete termination records for every regular, init, and ephemeral container. All originating container IDs must match. The same originating node must be available, and its live kubelet inventory must confirm that the originating pod UID is absent. Missing objects, a recreated pod with the same name, inaccessible nodes, active debug containers, unknown states, or replaced container IDs cause the tool to stop.

Kubernetes explicitly warns that [force deletion can remove the API object before the container has stopped](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination). A `NotFound` response is therefore never accepted as evidence. The live inventory check uses Kubernetes' [kubelet running-pod endpoint](https://github.com/kubernetes/kubernetes/blob/master/pkg/kubelet/server/server.go).

## Procedure

1. Review the account job and its private resource. Choose the interrupted phase and confirm its recorded workflow/run/activity/attempt, account UID, frozen desired claims, worker instance, and environment. For sessions, also confirm the unique operation ID and frozen cutoff. Preserve the originating pod and its termination evidence before deployment cleanup or garbage collection. Do not force-delete it or manually clear the account resource.
2. Use the operational Google credentials and Kubernetes context for that environment. Build the shared packages so the CLI and worker use the same execution-key implementation:

   ```sh
   pnpm run build:packages
   ```

3. Preview the verification using the actual configuration, UID, and job ID:

   ```sh
   ./scripts/with-node22.sh node scripts/temporal-reconcile-account-execution.mjs \
     --config /secure/temporal-staging.json \
     --uid ACTUAL_TARGET_UID \
     --job ACTUAL_JOB_ID \
     --phase claims
   ```

   For an interrupted session revocation, use `--phase sessions` instead. A session preview binds its proof to `sessionExecution`; a preexisting claims witness does not attest that the session caller stopped.

   Preview performs authenticated reads and writes no database records. It reports `remoteRpcCompletionProven: false` because worker termination does not prove that a previously submitted Auth request finished remotely.

4. After reviewing the preview, run the same invocation with `--apply`. The tool gathers the Kubernetes evidence again inside a Firestore transaction. It compares the complete private resource/job/intent/entity snapshot, rejects a changed generation or claims payload, and never replaces an existing witness. It atomically creates the private drain witness and an immutable audit entry under `durableAccountExecutionAudits`. The audit records the chosen phase, and session audits also record the frozen operation ID and cutoff. Claims are represented by a digest in the audit; credentials and bearer tokens are never recorded.
5. Continue through the trusted account receipt reconciliation action for the same phase (`confirm_access_applied` or `confirm_sessions_revoked`). It must verify the single-shot transport marker and perform a fresh Firebase Auth read and require the exact frozen claims **and** the positive `temporalAccountClaimJobId` marker before marking the receipt applied and resuming. The termination attestation alone must never authorize replaying a claims mutation or treating an absent marker as proof that nothing happened. For sessions, a fresh Auth read must show the exact full frozen `sessionClaims` payload and its unique `temporalAccountSessionOperationId`, plus `tokensValidAfterTime` at or beyond the frozen cutoff. A cutoff alone could predate this request and never establishes completion. The original claims checkpoint must also remain confirmed. Neither the CLI nor the resolver issues another Auth mutation. Contradictory or unknown Auth results remain blocked for review.

The witness binds the original execution, process, and infrastructure identities. It has no lease or expiry that eventually grants permission. A transaction conflict or changed Kubernetes evidence requires a new review; the tool does not weaken the checks to make an old preview succeed.

## Evidence that has already been lost

If the original pod was garbage-collected, its container identity was replaced, or the node cannot provide an authoritative live inventory, this tool cannot attest termination. Preserve the pending resource and prevent competing role changes. Re-establish authoritative infrastructure/provider evidence through incident response rather than substituting a checkbox, elapsed time, a new pod's status, or a manual `state: applied` edit. Deleted-object recovery needs a separately reviewed evidence source; this script deliberately does not claim to solve that case.

A remotely ambiguous Auth mutation can outlive its worker. Keep newer claims writes blocked until the trusted reconciliation path has positively observed the original operation's exact desired result. Pod termination establishes worker quiescence only, and the audit states that limit explicitly.

## Verification

The Node 22 regression suite exercises preview without writes, exact identity binding, private atomic witness/audit creation, concurrent receipt/generation changes, existing-witness protection, deleted/recreated/alive pods, restarted container identities, node uncertainty, active ephemeral containers, malformed live inventories, cross-environment mismatches, authenticated operator identity, explicit phase argument handling, uniquely marked session payload/cutoff checks, separate claims/session witness identities, and atomic rejection when any frozen session field or execution epoch changes:

```sh
./scripts/with-node22.sh node --test scripts/temporal-reconcile-account-execution.test.mjs
```

Tests use an isolated fake Firestore transaction and Kubernetes reader. They perform no live writes, Auth mutations, infrastructure changes, or provisioning.
