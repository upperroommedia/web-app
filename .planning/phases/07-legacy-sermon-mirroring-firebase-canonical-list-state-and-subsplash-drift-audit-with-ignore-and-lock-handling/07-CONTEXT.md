# Phase 07 Context

## Working Title

Legacy sermon mirroring, Firebase canonical list state, and Subsplash drift audit with ignore-and-lock handling

## Why This Phase Exists

Phase 06 hardens overflow-chain behavior and makes root-vs-overflow list handling explicit, but it also surfaced a larger product-direction need:

- Firebase should become the canonical editorial source of truth for sermon metadata, list membership, and list ordering.
- Subsplash should become a publishing projection plus remote media host for legacy content.
- Historical data is not fully mirrored or fully reconciled today, so any "Firebase is canonical" rollout must include drift detection, reconciliation, and safe read-only behavior when confidence is incomplete.

This phase captures those migration and conflict-resolution needs explicitly so they are not lost while Phase 06 finishes verification.

## Key Product Decisions Captured From Discussion

### 1. Canonical ownership model

Firebase should own the canonical editorial state for:

- sermon metadata
- list membership
- list ordering
- speaker / series / topic relationships
- publish status
- overflow-chain structure

Subsplash should continue to own:

- remote media items already created there
- remote list row ids / page row ids
- remote audio playback/download locations for legacy sermons

### 2. Audio ownership split

There are two sermon origins and they should be handled differently:

- New sermons uploaded via the app:
  - audio remains owned by Firebase / GCP storage
  - Firebase is canonical
  - Subsplash receives a published projection
- Legacy sermons that already exist only in Subsplash:
  - mirror metadata into Firebase
  - do **not** migrate audio into GCP right now
  - continue using the existing Subsplash audio/media URL or remote media reference

The explicit reason for this split is cost and scope: migrating all historical audio blobs into GCP now would be expensive and is not required to make Firebase the primary application data source.

### 3. Asset-origin awareness is required

Once legacy sermons are mirrored, the app must support both asset origins cleanly.

The sermon model should support a durable distinction like:

- `audioSource: 'gcp' | 'subsplash'`

For GCP-backed sermons:

- use the existing Firebase/GCP audio pipeline and storage fields

For Subsplash-backed legacy sermons:

- preserve the `subsplashId`
- preserve the remote audio/playback/download reference needed to continue using the existing asset

Any UI or processing flow that assumes every sermon has GCP-backed audio will need to branch on the sermon's audio-source/origin model.

### 4. Matching strategy for mirroring and reconciliation

The primary join key between remote Subsplash media and local Firebase sermons should remain:

- `Subsplash media item id` -> `sermons.subsplashId`

Matching must **not** rely on weak heuristics like title, date, or speaker alone when creating authoritative local links.

If a remote Subsplash row has no matching local sermon by `subsplashId`:

- do not invent a sermon automatically
- classify it as remote-only / unmatched
- surface it in diagnostics
- keep risky list mutations blocked until reconciled

### 5. Historical list mirror backfill is separate from hierarchy metadata backfill

There are two different migration layers:

1. Hierarchy metadata backfill:
   - root/overflow identification
   - `isRootList`
   - `isMoreSermonsList`
   - `rootListId`
   - `overflowDepth`
   - `logicalCount`
   - `hasOverflowPages`

2. Physical page mirror backfill:
   - populate `lists/{listId}/listItems/*` from actual remote Subsplash page rows

The second backfill is only complete when remote Subsplash media rows can be matched safely to local sermons.

### 6. Drift audit must run when opening a list

When an admin opens a list detail page, the app should run a verification/audit comparing:

- local Firebase logical list state
- local Firebase physical page mirror state
- current Subsplash physical list/page state

This is required to detect:

- manual edits made directly in Subsplash
- ordering differences
- membership differences
- metadata differences
- missing local mirrors
- unmatched remote-only sermons

### 7. Drift should never auto-overwrite either side

If Firebase and Subsplash differ, the app should not silently decide a winner on page load.

The page should stay readable, show a clear warning, and present explicit user choices.

### 8. Required drift outcomes

At minimum, the system should support these resolution paths:

- update Firebase to match Subsplash
- update Subsplash to match Firebase
- ignore for now

### 9. Ignore must keep the list locked

If the user chooses to ignore drift:

- the drift warning remains visible
- the list stays locked for reorder / remove / destructive edits
- the page remains readable
- no overwrite happens automatically on either side

This is especially important for local/dev workflows against real Subsplash where differences may be intentional or informational and should not force repair.

### 10. Drift decisions should be auditable

Ignoring drift should not be a purely local dismissal.

We should consider persisting drift-resolution records that capture:

- list id / logical root
- drift type
- detected timestamp
- chosen action (`firebase_wins`, `subsplash_wins`, `ignored`)
- actor/user id

That gives the team traceability around why a list is currently locked or why a mismatch was intentionally deferred.

## Expected Drift Categories

The audit layer should be able to classify issues such as:

- `in_sync`
- `membership_mismatch`
- `order_mismatch`
- `metadata_mismatch`
- `remote_only_items`
- `local_only_items`
- `mirror_coverage_incomplete`
- `ambiguous_match`
- `chain_structure_mismatch`

These categories should drive both the UI banner text and whether mutations remain enabled or locked.

## Expected UX Behavior On List Open

When a user opens a list:

1. Load the Firebase root list state
2. Load the current Subsplash chain/page state
3. Compare the two
4. Render one of:
   - no drift -> normal editing allowed
   - drift detected -> warning + explicit actions + locked list

For the order-drift example discussed:

- if Subsplash ordering differs from Firebase ordering, the page should clearly say that the list was edited directly in Subsplash (or otherwise changed remotely)
- the user should then explicitly choose whether Firebase should be updated to match Subsplash, Subsplash should be updated to match Firebase, or the drift should be ignored while preserving read-only lock state

## Safe Behavior For Unmatched Historical Data

We already know there are historical sermons that exist in Subsplash but are not fully mirrored in Firebase.

That means:

- physical list mirror backfills will not always be complete on first pass
- some list pages must remain readable-but-locked until reconciliation is done
- the app must refuse destructive mutations when it cannot prove the local model fully represents the remote state

This is preferable to making unsafe guesses that could corrupt list membership/order.

## Relationship To Phase 06

Phase 06 solves:

- explicit root-vs-overflow metadata
- root-only discovery/selection
- safer overflow detail/reorder/delete semantics

Phase 07 is intended to build on top of that by adding:

- full legacy sermon mirroring strategy
- Firebase-canonical editorial data model for historical + new sermons
- list-open drift detection
- user-visible conflict resolution
- ignore-with-lock behavior
- reconciliation of remote-only historical sermons

## Likely Deliverables For Planning

The planning phase should probably break this into workstreams such as:

- legacy sermon reconciliation audit/reporting
- canonical sermon asset-origin model (`gcp` vs `subsplash`)
- list drift-audit backend contract
- list drift warning / resolution UI
- ignore-with-lock persistence and behavior
- historical list-item mirror backfill strategy
- safe mutation gating when mirror/reconciliation coverage is incomplete

## Notes About Current Risk

This phase should assume the following:

- historical production data is not fully mirrored in Firebase today
- direct manual edits in Subsplash are possible and must be accounted for
- Firebase cannot safely become the sole editable source of truth until reconciliation + drift detection exist
- the rollout should prefer read-only safety over silent automatic repair
