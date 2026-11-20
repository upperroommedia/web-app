# Host media coordinator (inactive until native acceptance)

`coordinator.py` is a Linux root-host daemon, not an application-container lock.
It has no installation, policy generation, automatic recovery, or deployment
entrypoint. Run acceptance checks before installing it. No current host capacity
or identity is supplied by this directory.

The fixed socket is `/run/urm-host-media/coordinator.sock`. Its root-owned directory must be `0711` or `0755`, allowing nonroot clients to traverse but never replace the socket. Policy and state directories remain root-only `0700`. A connection sends one
UTF-8 JSON line, at most 16 KiB, and receives one JSON line. Exact request shapes:

```
{"v":1,"action":"reserve","id":"<uuid>","kind":"legacy-full|canary|acquisition"}
{"v":1,"action":"get","id":"<uuid>"}
{"v":1,"action":"enroll","id":"<uuid>","childPid":123}
{"v":1,"action":"verify","id":"<uuid>"}
{"v":1,"action":"stop","id":"<uuid>"}
{"v":1,"action":"close","id":"<uuid>"}
{"v":1,"action":"seal","id":"<uuid>"}
{"v":1,"action":"release","id":"<uuid>"}
{"v":1,"action":"unstarted","id":"<uuid>"}
```

`childPid` is the caller container's PID, resolved only among the original peer's
current direct children. `reserve` must receive its own known successful ACK
before a child is forked. `get` is readback, **never authorization to fork**.
`enroll` must receive its own known ACK before execution IPC. `verify` is sent by
that exact enrolled child before it starts work. No request accepts paths,
resource budgets, images, commands, task data, or an authorization boolean.
Success is `{v:1,id,state,directory?,groupAbsent?,peerBound?,receiptHash?,descendantsStopped?}`; every failure is
`{v:1,error:"UNAVAILABLE"}`. The directory is `/workspace/host-resource/<uuid>`
for legacy/canary work and `/workspace/yt-acquisition-scratch/<uuid>` for acquisition.
Both applications must bind the policy's physical roots at those distinct fixed paths; the admission client
must use the returned directory for **all** operation files.

An uncertain reserve ACK is GET-only and may only be abandoned through
`unstarted` by the still-live original peer, with no enrollment attempt or new
child since reservation. An uncertain enrollment ACK is GET-only/no execution
IPC: stop the original child and request `close`. `close` never signals; it checks
the retained original pidfd is dead and the original owned cgroup is empty.
`stop` uses only those retained handles. A release journal atomically follows an
immutable native-drain receipt. There is no TTL, reconnect adoption, saved-PID
kill, or daemon-restart recovery: an outstanding reservation at restart fences
the daemon. Host-native operator reconciliation is deliberately unimplemented.

Acquisition uses a distinct cleanup sequence: original live child CLOSE ->
`stop` -> `seal` -> immutable application database original-close transaction ->
`release`. `seal` requires original pidfd death and empty held cgroup, writes
`state:"drained"`, and returns its immutable `receiptHash`/`groupAbsent` while
retaining the physical reservation. GET drained is observation only, not release
or new execution permission. `release` is acquisition-only and requires drained;
the daemon receives no Firebase credential, database boolean or replacement
authorization. The application must confirm its exact immutable database close
before requesting this single release. `close` is rejected for acquisition;
legacy/canary retain their original immediate-close protocol. Acquisition closed
readback preserves the same original drain hash, with a separately journaled
release event. Reserved/enrolled replies also expose their immutable event hash
for the actual application's known-ACK episode binding; a GET hash never becomes
a fresh fork or IPC grant.

Closed/unstarted success/GET is available only after native closure and durable
release both completed; acquisition drained remains explicitly nonterminal and
retains reservation. A close fact followed by nonempty-directory, cgroup or
release-journal failure remains fenced and cannot yield a successful terminal
reply. In-memory completed readback retains original handles; after 64 completed
episodes the daemon refuses new reservations rather than evict uncertain ACK
history. Restart is not an acknowledgment-recovery mechanism.
`descendantsStopped:true` means the coordinator issued its one original-scope
kill. It is sealed into the immutable close fact and retained by GET. A parent
must reject business success if cleanup had to kill remaining work, even when
the original direct child exited successfully.

Policy is a root-owned, non-writable, single-link regular JSON file at
`/etc/urm-host-media/policy.json`, in a root-only directory. Its exact schema is
specified by `validate_policy` in the source. Supply reviewed actual identities,
not a template derived from the historical host inventory. Every running Docker
container must be listed with exact ID/image/UID/cgroup/resource/log settings.
The declared coverage must include staging and production pipelines, browsers,
and PO providers. Non-container executable/cgroup pairs must also be explicitly
reviewed. Unreviewed processes or containers deny admission. Apps have no Docker
socket access; only the host daemon reads native inspect data.

Both pipeline containers must natively declare `URM_HOST_RESOURCE_PROTOCOL=isolated-v1`;
matching image labels without enabled source wrappers do not suffice. The
installed `/usr/local/lib/urm-host-media/coordinator.py` must be root-owned,
non-writable and match the policy's `coordinatorSHA256`. Policy pins native boot,
container start/birth, UID, image and cgroup, not just reusable container names.
Finite host-process cgroups are required as well as container limits. Read-only
container roots, `no-new-privileges`, no added capabilities and only reviewed
bounded tmpfs/operation mounts are mandatory; existing unbounded containers do
not satisfy this policy. The same container may declare both `fullMount` and
`streamMount`; native inspect must then prove both distinct bind destinations.
Full/canary work uses the physical quota-backed root, acquisition uses the exact
256-MiB tmpfs root. This remains one host-wide slot and one application authority;
the daemon does not infer a task/host switch or a mount transition.

Required writable browser/cookie/authentication state is preserved through
explicit `authMounts`, never an unbounded writable-root exception. Each approved
bind must match its actual destination/source, UID/private mode, physical mount
device/inode/ID, project inheritance and kernel hard quota. The unused portion
of these quotas is additionally reserved in sampled physical headroom; it cannot
silently consume the full pipeline's 64 GiB plus 16 GiB. No provisioned auth
mounts or working native auth-profile policy are claimed by this source. A host
that cannot satisfy these bounds remains unavailable rather than losing its
authentication files or using read-only profiles as a fallback.

Full and canary workspace backing requires a pre-provisioned ext4/XFS physical
block filesystem with project quotas enabled. A dedicated empty project-owned
directory must have a **kernel-reported** 64 GiB hard quota, project inheritance,
the exact reviewed empty-directory metadata baseline, and at least 64 GiB plus 16 GiB available on that same
filesystem. Sparse files/loop/dm/network backing are not accepted. The quota is a
maximum, not an allocation guarantee: the coordinator retains one host-wide slot,
rechecks native headroom, and stops its owned scope on loss. Application budgets
remain mandatory; this daemon does not manufacture a 64 GiB host fallback.
Workspace mount roots are root-owned `0711`; individual operation directories
are original-peer-owned `0700`. The root filesystem is separately native-pinned
and must preserve at least 16 GiB free. No current machine values are provided.
Streaming acquisition uses a distinct pre-provisioned 256 MiB tmpfs, accounted
against finite memory limits. Both mounts, cgroup delegation, both image wrappers,
and auxiliary-process enforcement require real deployment validation. No mount,
cgroup limit, Docker configuration, or quota is auto-provisioned here.

Required native acceptance specifications are in `TEST_SPEC.md`. This source has
not itself established host capacity, production participation, or end-to-end
native helper acceptance. The application's physical gate must remain denied
until those checks and the client/full-pipeline integration pass.

The portable source tests exercise create-only journals and controlled native response boundaries. One temporary Unix-socket permission regression requires root to create a root-owned directory and then drops its client to UID/GID 65534; it skips on nonroot development machines. Existing CI runs that owned fixture with sudo. It never constructs or starts the host daemon and is not Docker/cgroup/capacity acceptance.

Acquisition successor source protocol keeps the original delegation/episode and
its owner, upload, result and `nativeClose/original` records intact. A strictly
later SDK attempt of the **same** native Workflow/run/Activity may prepare a new
UUID episode only after a source-classified provider `task_retry`, original
completed closure, released host scope and an empty predecessor upload journal.
The successor has its own runtime document, ownership, uploads and closure; an
atomic head/link update selects it. Immutable predecessor data **and native
creation/update stamps** are rechecked by later consumers. Lost intent ACKs
cannot backfill launch authorization, and HTTP never chooses an episode/retry.
The native client reports the safe retry to the original Activity retry policy.

This is a conservative known-provider-retry source path, not activation evidence.
Any prior upload, unknown/generic failure, unclaimed child, authentication wait
or archive wait remains fenced. Same-host authentication canary/generation and
bounded archive-resume integration are still required; a local Cloud Run canary
cannot substitute for retained-host authentication recovery. All physical and
operational activation gates above remain denied.

A positively never-IPC acquisition child has a separate cleanup path. The live
parent records attempted IPC before calling `send`, including a synchronous
throw or uncertain callback. Only a failed/cancelled original CLOSE with no send
attempt can use unclaimed cleanup. Known original reservation/enrollment, held
scope drain and absence of owner/birth/uploads are checked; an atomic execution
link fences any pending claim transaction. A claim that committed despite a lost
ACK requires its exact original owned closure instead. Physical release follows
an independent immutable unclaimed-close/seal readback. This link grants no
retry, successor, source adoption or reset to `prepared`; launch and HTTP
readback reject it. Unknown/mismatched facts retain the reservation.
