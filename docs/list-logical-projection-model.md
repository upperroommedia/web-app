# Logical List Projection Model

## Goal

Admin users should experience a single logical list, even when Subsplash physically stores that list across a root page plus one or more overflow pages.

The editor should:

- see one ordered list of sermons
- reorder that one list
- delete from that one list
- never need to think about overflow pages during normal editing

The backend should:

- know which physical Subsplash page currently owns each item
- know each item's physical page position
- know the root logical order
- translate logical edits into physical Subsplash mutations safely

## Canonical Model

There are two different representations of the same list:

1. Logical projection
2. Physical chain

### Logical Projection

The logical projection is the canonical admin-facing representation.

It lives under the root list and represents the full unified list order:

- `lists/{rootListId}/listItems/{sermonId}`

These documents are root-owned logical membership records, not physical page mirrors.

Each record should be treated as:

- this sermon belongs to the logical list rooted at `rootListId`
- this is the sermon’s logical order inside that unified list
- hidden placement metadata may describe where it currently lives physically in Subsplash

### Physical Chain

The physical chain is the implementation detail required by Subsplash:

- root page
- overflow page 1
- overflow page 2
- etc.

Each node in the chain has:

- Firestore list doc id
- Subsplash list id
- depth
- physical item count

The physical chain is used for:

- publishing to Subsplash
- deleting from the correct physical row
- repartitioning after reorder
- diagnostics and drift detection

It is not the primary editor-facing source of truth.

## Why This Separation Exists

Historically, local `lists/{listId}/listItems` started as logical membership written at upload time.

Later, the list details page began treating those same subcollections as if they were exact per-page physical mirrors of the Subsplash overflow chain.

That was a model mismatch:

- upload writes root logical membership
- publish mutates Subsplash physical pages
- nothing automatically repartitions local Firestore list items into overflow page subcollections

So the page could show a warning even when Subsplash was perfectly correct.

## Correct Interpretation Of Root `listItems`

For the root list:

- `lists/{rootListId}/listItems/*` is the canonical logical projection

For overflow pages:

- `lists/{overflowListId}/listItems/*` should not be required for the normal editor experience
- if they exist, they are diagnostic or temporary reconciliation artifacts, not the canonical admin model

## Hidden Placement Metadata

The root logical projection may store hidden placement metadata for each sermon, for example:

- `physicalPlacement.firestoreListId`
- `physicalPlacement.subsplashListId`
- `physicalPlacement.overflowDepth`
- `physicalPlacement.position`
- `physicalPlacement.listItemId`

This metadata is for the backend and diagnostic tooling.

It should not change the user-facing mental model of "one list".

## Page Load Flow

When the root list details page opens:

1. Load overflow chain state from `getlistoverflowchain`
2. Load the root logical projection from `lists/{rootListId}/listItems`
3. Build one unified ordered list from the root projection
4. Derive subtle boundary markers from physical chain counts
5. Render a single list to the user

### Boundary Markers

Boundary markers are visual hints only.

They may show where the physical Subsplash pages split, but the user is still editing one logical list.

## Read-Only Rules

The page should become read-only when:

- the physical chain audit reports blocking structural issues
- drift is detected between the logical projection and the physical Subsplash chain
- the user explicitly chooses to ignore drift for now

The page should not become read-only merely because overflow page subcollections are absent.

That absence is expected in the logical projection model.

## Reorder Flow

When the user reorders the unified list:

1. Send the unified logical order to `reorderlistitems`
2. Backend loads the physical chain
3. Backend translates logical order into physical page partitions
4. Backend patches Subsplash pages in sequence
5. Backend returns physical assignments
6. Root logical projection updates:
   - `position`
   - hidden `physicalPlacement` metadata

The root logical projection remains the admin-facing source of truth.

Overflow page subcollections are not required for reorder to work.

## Delete Flow

When the user deletes a sermon from the logical list:

1. Determine the sermon’s logical membership from the root projection
2. Use the best known physical placement metadata
3. If necessary, search the physical overflow chain to locate the actual row
4. Delete from Subsplash
5. Remove the sermon from the root logical projection
6. Update `sermons/{sermonId}/sermonLists/{rootListId}`
7. Refresh root logical placement metadata as needed

Again, the user still experiences a single logical list.

## Drift Detection

Drift detection should run when the list is opened, not automatically during unrelated publish mutations.

The audit should compare:

- root logical projection membership/order
- actual physical Subsplash chain membership/order

Expected drift categories:

- order mismatch
- membership mismatch
- remote-only items
- local-only items
- metadata mismatch
- structural chain issues

## Drift Resolution UX

If drift is detected:

- show the list as readable
- show a warning
- keep risky actions locked
- let the user choose:
  - update Firebase to match Subsplash
  - update Subsplash to match Firebase
  - ignore for now

If ignored:

- keep the warning visible
- keep the list locked
- do not overwrite either side automatically

## Explicit Non-Goals

The system should not:

- auto-sync physical page mirrors during add-to-list or remove-from-list
- delete unpublished logical memberships because a physical page does not contain them yet
- require overflow page `listItems` subcollections for normal editing

## Current Practical Rule

Until a dedicated drift-resolution flow is implemented:

- root list `listItems` is the only editor-facing list source
- physical chain info comes from `getlistoverflowchain`
- reorder writes back to the root logical projection
- physical placement stays hidden implementation detail

This is the model to preserve going forward unless deliberately redesigned.
