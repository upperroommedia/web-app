# Source test specifications (not execution evidence)

Root owns all execution. Exercise the actual daemon source in an isolated Linux
fixture with owned Docker/cgroup/filesystem identities; do not use the current
host or modify existing staging/production containers for these tests.

## Wire and native peer identity

1. Reject duplicate JSON keys, NaN, extra keys, over-16-KiB lines, multiple lines,
   noncanonical UUIDs, unknown kinds/actions, arbitrary paths and boolean grants.
2. Reject a host peer, wrong UID/container/cgroup, PID reuse, changed boot/start
   ticks, changed PID namespace and restarted same-ID container. Pin exact source
   hash and root-only immutable policy; no world-writable or symlink replacement.
3. Resolve `childPid` through original parent direct children/NSpid. Reject an
   existing child from before reserve, grandchild, another container's same PID,
   changed birth, existing descendants or wrong UID/cgroup.
4. Exact child must `verify`; parent/other child cannot. Same verified context
   receives only the kind-fixed operation directory. Before this ACK no execution IPC.
   One index with both native binds may reserve full/canary at
   `/workspace/host-resource/<uuid>` or acquisition at
   `/workspace/yt-acquisition-scratch/<uuid>`, never cross the roots. Wrong source,
   destination, physical backing or non-256-MiB streaming tmpfs denies either mode.

## Durable single-attempt authority

5. Concurrent reserves produce one durable `active.json` before any directory,
   chown or cgroup mutation. Losing the ACK cannot authorize another fork. GET is
   readback only; a repeated reserve is rejected even with the same UUID.
6. Inject failure before/after every fsync, mkdir, cgroup write and ACK. Never
   finally-unlock. Unknown enrollment cannot be retried; it requires native stop
   and closure or stays fenced. Restart with outstanding active intent must not
   reconstruct pidfds, adopt stored PIDs/cgroups, delete reservations or admit.
7. Closed/unstarted GET on the same live peer returns the same `receiptHash` after
   a lost response. A different/reused/restarted peer cannot adopt it. Spent IDs
   never reserve again. A missing/incomplete release journal remains fenced.

## Actual enforcement and sampled resource safety

8. Require complete exact running-container inventory including both legacy
   images, browsers, PO providers and ancillary containers. Unexpected container,
   old image, writable root, privilege/cgroup/socket exposure, missing coverage,
   unbounded memory/PID/CPU/logs or unknown host executable denies admission.
9. Read effective ancestor limits, not just Docker requested limits. Changed
   native limits, log options, source mount device/inode/mount ID, binary hash or
   container birth denies/stops. Host executable/cgroup pairs must be bounded and
   counted; root cgroup/unknown auxiliary work is not a headroom allowance.
10. Require actual project-quota 64-GiB limit and native baseline, inherited
    project ID, physical ext4/XFS block backing and >=64+16 GiB free before full
    admission. Deny sparse/loop/dm/network/wrong-project/too-small/shared stale
    backing. Stream mode requires exact 256-MiB tmpfs. Never select a smaller full
    profile because a host has less capacity. No positive capacity claim from
    mocked statvfs/quota data.
11. Loss of headroom, native observation failure, >250-ms health sample or >500-ms
    stalled sampler stops only the original owned scope. Test stalled Docker/read
    dependency while watchdog still acts; unknown kill/drain keeps the durable
    reservation. Do not interpret a successful signal write as termination.

## Original promise, descendants and cleanup

12. Actual owned child forks a descendant; parent closes while descendant lives.
    `close` must reject until original pidfd is dead AND recursive owned cgroup is
    empty. `stop` must reach descendants without signalling unrelated workers.
    Replacing/removing the cgroup/directory name must not redirect cleanup.
    `stop` waits up to three seconds for positive empty-scope/original-pidfd-death
    readback; a kill-write ACK alone cannot succeed. Concurrent watchdog/request
    calls issue at most one kernel kill. Uncertain kill remains GET-only/fenced.
13. Test original application promise and parallel I/O continuing after child
    close: the **application integration** must retain them before requesting
    close. The coordinator does not claim to observe JavaScript promise state.
14. `unstarted` requires original still-live peer, reserved state, no enrollment
    attempt, unchanged direct-child inventory and empty original scope. It cannot
    erase uncertain started work. Nonempty operation files are never deleted.
15. After source-native drainage, expiry, quota loss, auth revocation or metadata
    failure must not require a new resource grant for cleanup. Cleanup uses held
    original directory/cgroup descriptors and pidfd, writes immutable close proof
    before release, and cannot target a replacement path/PID.
16. Acquisition must reject `close`. `seal` requires exact original child pidfd
    death, empty held scope and a prior native stop; it persists drained without
    removing active reservation, directory, or cgroup. Drained GET returns the
    identical hash/group-absence fact and cannot authorize a new reservation,
    enrollment or execution. Unknown seal ACK is GET-only. `release` before
    drained rejects; release after the application's exact immutable database
    close preserves original drain hash and appends separate release lineage.
    Simulate database close ACK loss: the app must confirm exact original close
    by GET before its one release, with no second resource/task authority. A
    failed physical release must not yield a successful closed GET. Legacy and
    canary continue their existing close path and cannot call seal/release.
17. Reserved/enrolled hashes bind actual known original ACKs. Unknown reserve or
    enroll followed by GET of the same hash still never grants fork/IPC. Native
    descendant kill is sealed in drained/closed facts and prevents business
    success/adoption even if a direct child exited zero.

These fixtures do not establish current physical host capacity, both deployed
images' participation, production safety, remote HTTP/OIDC/native helper parity,
or activation authorization. Keep the application physical gate denied until
those independent native acceptance checks pass.
