# Firebase Functions

The Firebase Functions context owns server-side workflows that mutate local Firestore records and external publishing destinations.

## Language

**Callable Workflow**:
A server-side command invoked from the web app, with authentication, validation, mutation, and error reporting.
_Avoid_: Endpoint, API handler

**Publishing Mutation**:
A server-side change to Subsplash or SoundCloud that must be coordinated with local Firestore state.
_Avoid_: Remote call, provider request

**Operation Key**:
A caller-provided idempotency identity for a publishing mutation or retryable workflow.
_Avoid_: Request id, dedupe key

**Subsplash Lock**:
A short-lived lock on a Subsplash entity such as a series, list, or media item to prevent conflicting mutations.
_Avoid_: Mutex, lease

**Idempotency Record**:
The stored result or failure for an operation key so retries do not duplicate external work.
_Avoid_: Cache entry, retry record

**List Overflow Chain**:
A root Subsplash list plus continuation lists used when visible content exceeds the root list capacity.
_Avoid_: Pagination, linked lists

**Root List**:
The canonical local list that owns the logical membership and may point to overflow lists.
_Avoid_: Main list, parent list

**Overflow List**:
A continuation list attached to a root list for additional published content.
_Avoid_: More list, child list

**Continuation Row**:
The Subsplash list row that links one list in an overflow chain to the next.
_Avoid_: Link row, more sermons row

**Published List Drift**:
A mismatch between local list projections, canonical memberships, and the current Subsplash list rows.
_Avoid_: Desync, inconsistency

**Remote Membership Hash**:
A snapshot identity for remote series or list membership used to reject stale mutations.
_Avoid_: Version, checksum

**Runtime Alert**:
An operational notification emitted when a workflow failure needs maintainer attention.
_Avoid_: Notification, email

**Speaker Request**:
A user's request to create or associate a speaker before the speaker is accepted into the catalog.
_Avoid_: Speaker submission, pending speaker

**Role Request**:
A user's request for elevated app permissions such as uploader or publisher.
_Avoid_: Permission request, access request
