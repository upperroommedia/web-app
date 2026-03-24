# Phase 06: Add-to-list overflow chain hardening and nested list admin model - Research

**Researched:** 2026-03-14
**Domain:** Firestore list modeling, Subsplash overflow-chain operations, root-only admin discovery, and chain-aware admin UX
**Confidence:** MEDIUM

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Visibility rules
- Overflow pages are never selectable or assignable in uploader or admin selection flows.
- Overflow pages are not first-class discovery records in list tables or selector/search results; main/root lists are the only discoverable list entities in those surfaces.
- Admin list tables/search results should show the logical total across the whole overflow chain, not just the first physical Subsplash page.
- Root lists may show an admin-only overflow indicator/badge in discovery surfaces so operators know nested pages exist.
- Direct navigation to an overflow list URL should redirect to the root list detail page.

### Root detail page
- The root list detail page is the single admin entry point for a logical list, even when the underlying list spans multiple Subsplash pages.
- Sermons from overflow pages should appear as one aggregated list on the root detail page.
- The aggregated sermon list should include subtle page-boundary markers so admins can understand where Subsplash page boundaries fall without breaking the unified view.
- The root detail page should include a compact chain panel showing overflow-page metadata: names, Subsplash IDs, item counts, and nesting depth/page order.
- The chain panel is inspect-only. It may include lightweight helpers like copy/open-link affordances, but it does not expose page-specific management actions.
- Reordering from the root detail page should apply to the whole logical list, with the system remapping page boundaries underneath.
- If the system detects overflow-chain inconsistencies, the root detail page should remain readable but show a clear warning and disable risky actions such as reorder/destructive operations until the chain is consistent.

### Delete and edit behavior
- Standard admin delete flow for a root list is blocked when overflow pages exist.
- When delete is blocked, the UI should clearly explain that overflow pages exist and stop; no silent cascade and no generic success path.
- Delete confirmation should include a cascade-aware summary when overflow pages exist so admins understand the affected chain before any destructive action is allowed.
- Root-list metadata edits should keep overflow-page naming aligned to the canonical pattern: `More {root list name} sermons`.
- Overflow pages should continue to function as the bottom-of-list continuation path for the main list, not as separately curated admin entities.

### Claude's Discretion
- Exact wording and visual treatment of overflow badges, chain warnings, and copy helpers.
- Exact placement of the compact chain panel and boundary markers within the root detail page layout.
- Whether the logical total and overflow indicator live in one metadata block or as separate UI elements in list discovery surfaces.

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

## Summary

The codebase already has robust low-level overflow mutation behavior in `functions/src/addToList.ts` and `functions/src/removeFromList.ts`, plus emulator-backed tests for page numbering, retry bugs, concurrent access, and overflow removal. The weak point is the admin model exposed above that layer: overflow identity is implicit, root-only discovery is enforced ad hoc in several UI/query paths, the admin detail page is still single-physical-list, and the delete path is chain-blind.

Plan this phase around making logical-root identity explicit instead of continuing to infer it from `isMoreSermonsList` and `moreSermonsRef` alone. Keep the root list as the only selectable/admin-managed entity, keep overflow pages hidden implementation details, add explicit chain metadata to list documents and indexed search records, and centralize chain traversal/audit in one helper layer that every admin surface uses.

The biggest technical risk is consistency drift between Firestore and Subsplash. Existing tests already document why this is fragile: `addToList` performs remote Subsplash calls inside a Firestore transaction and relies on recovery logic when transactions retry. Phase 06 should not expand that pattern into new delete/edit/reorder behavior. New admin actions should run behind existing lock/idempotency wrappers, use explicit chain preflight/audit, and block risky actions when chain state is inconsistent.

**Primary recommendation:** Plan Phase 06 as an explicit logical-root metadata migration plus shared chain-audit layer, then wire list discovery, root-detail redirect, logical totals, delete blocking, and whole-chain reorder to that single model.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Next.js | 16.1.6 | Admin pages and routing | Existing admin surfaces already live under `apps/web/pages/admin/**`. |
| React | 19.2.4 | Client UI state for list/admin flows | Existing list detail, selector, and admin tables already use it. |
| Firebase Web SDK | 12.10.0 | Firestore reads/writes from admin UI | All admin list pages and selectors use Firestore directly. |
| Firebase Admin + Functions | 13.7.0 / 7.1.1 | Callables, triggers, and secured Subsplash mutations | Overflow mutations, lock wrappers, and listeners already live here. |
| Algolia Search | 5.27.0 | Admin list discovery/search/sort replicas | Admin list table and selectors already depend on indexed list records. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@dnd-kit/core` | 6.3.1 | Drag-and-drop list ordering UI | Keep for root-detail reorder interactions. |
| `@dnd-kit/sortable` | 10.0.0 | Sortable list behavior | Keep for the logical root-detail ordering surface. |
| MUI | 7.3.9 | Admin cards, tables, chips, alerts, layout | Keep for badges, chain panels, warnings, and action states. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Implicit root detection with `isMoreSermonsList !== true` | Explicit `isRootList`, `rootListId`, `overflowDepth` metadata | Explicit fields require a migration/backfill, but they remove duplicated inference logic across Firestore, Algolia, and UI code. |
| Deriving logical totals at render time by traversing chains per row | Persisted root-level `logicalCount` field | Persisting `logicalCount` adds write/update work, but client-side traversal breaks Algolia sort/pagination and causes N+1 fetches. |
| Calling existing `deleteSubsplashList` directly from admin table | Chain-aware delete preflight/blocking callable | Preflight adds an extra request, but prevents accidental orphan/cascade behavior. |

**Installation:**
```bash
# No new dependencies are required for this phase.
pnpm install
```

## Architecture Patterns

### Recommended Project Structure
```text
packages/shared/types/List.ts                # Canonical root/overflow metadata contract
apps/web/types/List.ts                       # Re-exported app-side list type parity
functions/src/helpers/listOverflowChain.ts   # Chain traversal, audit, totals, and naming helpers
functions/src/addToList.ts                   # Overflow creation + root/chain metadata writes
functions/src/removeFromList.ts              # Chain-aware removal using shared chain helper
functions/src/reorderListItems.ts            # Whole-chain reorder/remap entry point
functions/src/deleteSubsplashList.ts         # Delete preflight/blocking behavior
apps/web/pages/admin/lists.tsx               # Root-only table totals, badges, delete UX
apps/web/pages/admin/lists/[listId].tsx      # Root redirect + aggregated detail page
apps/web/components/ListSelector.tsx         # Root-only selection contract
apps/web/utils/algolia/searchRecords.ts      # Root-only filters and logical-count sorting
apps/web/utils/mockAlgoliaSearchClient.ts    # Emulator parity for the same root-only model
```

### Pattern 1: Explicit Logical Root Metadata
**What:** Add explicit chain metadata to every list document instead of inferring root-vs-overflow status from the absence or presence of `isMoreSermonsList` alone.

**Use these fields:**
- `isRootList: boolean`
- `rootListId: string` (Firestore root doc id; root points to itself)
- `overflowDepth: number` (`0` for root, `1+` for overflow pages)
- `logicalCount?: number` (root only)
- `hasOverflowPages?: boolean` (root only)

**Keep existing fields:**
- `moreSermonsRef` as the remote next-page Subsplash id
- `isMoreSermonsList` temporarily for backwards compatibility during migration

**When to use:** All selector/search/table/detail/delete/reorder flows.

**Example:**
```ts
// Source: recommended extension of packages/shared/types/List.ts
type OverflowChainMeta = {
  isRootList: boolean;
  rootListId: string;
  overflowDepth: number;
  logicalCount?: number;
  hasOverflowPages?: boolean;
};
```

### Pattern 2: Server-Owned Chain Audit Helper
**What:** Centralize chain traversal and integrity checks in one helper or secured callable. The helper should accept any list doc and return a normalized root/chain view with blocking warnings.

**Return shape should include:**
- root list doc
- ordered chain nodes with Firestore id, Subsplash id, depth, name, physical count
- `logicalCount`
- integrity issues
- `canMutate` / `blockingIssues`

**When to use:** Root-detail redirect, chain panel, delete preflight, rename cascade, reorder preflight, and admin badges.

**Example:**
```ts
// Source: recommended helper for functions/src/helpers/listOverflowChain.ts
type OverflowChainState = {
  rootListId: string;
  nodes: Array<{
    firestoreListId: string;
    subsplashId?: string;
    name: string;
    depth: number;
    physicalCount: number;
  }>;
  logicalCount: number;
  issues: Array<{
    code: string;
    severity: 'warning' | 'blocking';
    message: string;
  }>;
  canMutate: boolean;
};
```

### Pattern 3: Root-Only Discovery Contract
**What:** Replace scattered overflow filtering with one canonical root-only query contract.

**Use:**
- Firestore recent-list fetches: query only `isRootList == true`
- Algolia list search/table: `filters: 'isRootList:true'`
- Mock Algolia client: same field-based filtering, not `isMoreSermonsList !== true`

**When to use:** `ListSelector`, admin list table, uploader category fallback, and any future list picker.

**Example:**
```ts
// Source: apps/web/utils/algolia/searchRecords.ts + Algolia filters docs
const response = await searchClient.search({
  requests: [
    {
      indexName: resolveListIndexName('logicalCount', 'desc'),
      query,
      filters: 'isRootList:true',
    },
  ],
});
```

### Pattern 4: Whole-Chain Reorder With Boundary Remap
**What:** The UI should send one logical order for the root list. The server should partition that logical order back into physical Subsplash pages.

**Important boundary rule:** the current overflow implementation uses `maxListSize - 1` content rows plus one link row for every non-terminal page.

**When to use:** Root-detail reorder save action.

**Example:**
```ts
// Source: functions/src/addToList.ts + functions/src/reorderListItems.ts
const nonTerminalCapacity = maxListSize - 1;
const pages = partition(logicalMediaRows, nonTerminalCapacity);

// For each non-terminal page:
// - content rows fill positions 1..N
// - trailing link row points to the next page
// For the terminal page:
// - content rows fill the page with no trailing link row
```

### Pattern 5: Root Detail = Logical Membership + Chain Diagnostics
**What:** Treat `lists/{rootListId}/listItems` as the editable logical membership surface, then layer chain diagnostics and page-boundary markers on top of it using server-derived chain state.

**When to use:** `apps/web/pages/admin/lists/[listId].tsx`.

**Planner implication:** do not split admin editing across hidden overflow list pages. Redirect overflow page URLs to the root detail immediately after resolving chain state.

### Anti-Patterns to Avoid
- **Ad hoc overflow filtering:** Current UI code filters overflow docs separately in `ListSelector`, Algolia search adapters, uploader fallbacks, and mock search. Move to one explicit root-only field.
- **Reusing `count` as the logical total:** `count` is currently maintained per `lists/{listId}/listItems` listener and is not a safe root logical total for mixed legacy/runtime data.
- **Calling existing single-list reorder for a full logical chain:** `functions/src/reorderListItems.ts` only reorders one remote physical list and preserves non-target rows in place.
- **Directly deleting a root list with overflow pages:** `apps/web/pages/admin/lists.tsx` currently calls `deleteSubsplashList` and deletes the Firestore doc without chain preflight.
- **Adding new remote side effects inside Firestore transactions:** Firestore retries transaction functions; expanding this pattern increases drift risk.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Root/overflow detection | Multiple `isMoreSermonsList !== true` checks spread across UI and search | Explicit root metadata + one chain helper | Prevents drift between Firestore queries, Algolia filters, and emulator mocks. |
| Logical totals in admin discovery | Recursive client fetches per table row | Persisted root `logicalCount` plus indexed search/sort support | Table pagination and Algolia replica sorting need one stored value. |
| Whole-chain reorder from the browser | Client-only row math for each physical page | One callable that partitions logical order back into remote pages under lock | Boundary math is coupled to Subsplash link-row behavior and lock/idempotency. |
| Delete safety | Blind delete + local doc removal | Chain-aware preflight that blocks root delete when overflow exists | Prevents silent orphaning and matches the phase requirement exactly. |
| Chain warnings | Inline one-off checks in the page component | Shared audit result with blocking/warning codes | The same integrity rules must govern redirect, detail rendering, delete blocking, and reorder disablement. |

**Key insight:** The hard part of this phase is not adding more UI. The hard part is giving the whole system one authoritative definition of "logical root list" so discovery, totals, redirects, warnings, rename cascades, and reorder all agree.

## Common Pitfalls

### Pitfall 1: Physical Count vs Logical Total Drift
**What goes wrong:** Admin tables/search can show the wrong total because `count` is not a guaranteed logical-chain total.

**Why it happens:** `count` is updated by `functions/src/DocumentListeners/Lists/listItemOnCreate.ts` and `listItemOnDelete.ts` per physical `lists/{listId}` document, while runtime overflow docs are created with `count: 0` and imported Subsplash lists can start with physical counts from `populateListsHelper.ts`.

**How to avoid:** Introduce a root-only `logicalCount` and treat current `count` as physical/local membership state.

**Warning signs:** Root table count matches only the first page, overflow docs show `0`, or sorting by count does not reflect the logical chain.

### Pitfall 2: Canonical Overflow Naming Already Drifts From the New Requirement
**What goes wrong:** Existing overflow pages do not follow the desired canonical name.

**Why it happens:** `functions/src/addToList.ts` currently creates new overflow titles as `More ${baseTitle}`. The phase decision requires `More {root list name} sermons`.

**How to avoid:** Treat rename/backfill as part of the phase, not just a UI label change. Root metadata edits must cascade to overflow page names.

**Warning signs:** Existing overflow pages have titles like `More Original List` instead of `More Original List sermons`.

### Pitfall 3: Single-List Reorder Logic Does Not Generalize to Chains
**What goes wrong:** Reordering a logical list with the current callable leaves page boundaries wrong because the callable only reorders one remote physical list.

**Why it happens:** `functions/src/reorderListItems.ts` preserves non-target rows in place inside one Subsplash list; it does not repartition media rows across linked overflow pages.

**How to avoid:** Add a root-aware reorder path that remaps the full logical order across the chain and only then updates local positions.

**Warning signs:** Link rows remain in place while page capacities are exceeded or item order diverges between local root order and remote Subsplash pages.

### Pitfall 4: Firestore Transaction Retries Can Re-run Remote Side Effects
**What goes wrong:** Subsplash can be updated while Firestore metadata is only partially written, creating inconsistent chains.

**Why it happens:** Firestore transaction functions may run more than once, and official docs warn against directly modifying application state inside transaction functions. Existing tests in `functions/src/test/addToList/transactionRetryInconsistency.test.ts` document this exact bug shape.

**How to avoid:** Do not introduce new remote side effects inside Firestore transactions for Phase 06. Keep using lock/idempotency wrappers and add explicit post-mutation audit/repair steps where needed.

**Warning signs:** An overflow list exists in Subsplash but the Firestore overflow doc is missing, or the parent `moreSermonsRef` is unset.

### Pitfall 5: Algolia Schema Changes Need Real and Mock Updates
**What goes wrong:** Search behaves differently between production and emulator/dev mode.

**Why it happens:** Real Algolia search uses explicit filters in `apps/web/utils/algolia/searchRecords.ts`, while emulator mode uses `apps/web/utils/mockAlgoliaSearchClient.ts`. Replica sort configuration also lives in `scripts/configure-algolia-list-sorting.mjs`.

**How to avoid:** Update all three together when introducing `isRootList` or `logicalCount`.

**Warning signs:** Root-only filtering works in one environment but not the other, or sort-by-count behaves differently locally vs production.

### Pitfall 6: Direct Overflow URLs Must Not Expose Mutating UI
**What goes wrong:** Operators can land on an overflow page route that still renders mutating controls before redirect/audit.

**Why it happens:** The current page loads one list doc directly from Firestore and treats it as editable.

**How to avoid:** Resolve root status before exposing reorder/delete actions. If the doc is not a root list, redirect to the root detail page.

**Warning signs:** `/admin/lists/{overflowId}` loads an editable page or shows page-local counts/actions.

## Code Examples

Verified patterns and repo-grounded examples:

### Root-Only Search Filter
```ts
// Source: https://www.algolia.com/doc/api-reference/api-parameters/filters/
// New list root filter should replace NOT isMoreSermonsList:true
const searchParams = {
  query,
  filters: 'isRootList:true',
  facetFilters: listType ? [[`type:${listType}`]] : undefined,
};
```

### Chain Audit Result for the Root Detail Page
```ts
// Source: recommended helper based on current addToList/removeFromList chain traversal
const chainState = await getOverflowChainState(rootListId);

if (!chainState.canMutate) {
  showWarningBanner(chainState.issues);
  disableActions(['reorder', 'delete']);
}
```

### Whole-Chain Boundary Remap
```ts
// Source: functions/src/addToList.ts
const nonTerminalCapacity = maxListSize - 1;
const logicalRows = orderedItems.map((item) => toSubsplashRow(item));
const chainPages = chunk(logicalRows, nonTerminalCapacity);

for (let i = 0; i < chainPages.length; i += 1) {
  const rows = [...chainPages[i]];
  if (i < chainPages.length - 1) {
    rows.push(createLinkRow(nextSubsplashListId));
  }
  await patchListRows(chain[i].subsplashId, rows, token);
}
```

## State of the Art

| Old Approach | Current Recommended Approach | When Changed | Impact |
|--------------|------------------------------|--------------|--------|
| Overflow/root identity inferred from optional `isMoreSermonsList` and `moreSermonsRef` | Explicit `isRootList`, `rootListId`, `overflowDepth`, `logicalCount` | Phase 06 target | Removes duplicated inference logic and enables root-only discovery/querying. |
| Admin list table/search sorts and displays `count` | Admin list table/search uses root-only `logicalCount` | Phase 06 target | Supports correct logical totals and sort replicas. |
| `/admin/lists/[listId]` edits one physical list | Root detail page is the single logical entry point and redirects overflow routes | Phase 06 target | Matches operator mental model and hides physical pagination. |
| Existing reorder callable handles one physical list | Root reorder partitions the logical order across the full chain | Phase 06 target | Preserves page boundaries and link rows correctly. |
| Existing delete flow can call `deleteSubsplashList` directly | Delete preflight blocks root deletes when overflow exists | Phase 06 target | Prevents unsafe or silent destructive behavior. |

**Deprecated/outdated:**
- Post-fetch overflow filtering via `list.isMoreSermonsList !== true` as the main root-only contract.
- Treating the current `count` field as a trustworthy logical total in admin discovery.
- Extending single-list reorder/delete logic to chain behavior without a dedicated chain audit/remap layer.

## Open Questions

1. **Does the root detail page need to render remote-only rows that have no local sermon document?**
   - What we know: editable local membership lives under `lists/{listId}/listItems`, while the overflow chain is managed remotely in Subsplash.
   - What's unclear: whether production chains can contain remote content that is not represented in local Firestore list membership.
   - Recommendation: decide this before planning. If out of scope, explicitly constrain Phase 06 to locally mirrored sermon rows plus chain diagnostics.

2. **Where is list-to-Algolia write-side indexing configured?**
   - What we know: search clients, root filters, and sort-replica scripts are in the repo, but write-side list indexing is not obvious in `functions/src`.
   - What's unclear: how new fields like `isRootList` and `logicalCount` will reach Algolia and how `attributesForFaceting` is currently managed.
   - Recommendation: identify the indexing owner/config first so the plan includes the real settings update path.

3. **Should root logical totals use a new field or replace `count`?**
   - What we know: `count` is already updated by list-item listeners and mirrored into sermon-list documents.
   - What's unclear: whether changing `count` semantics would create more confusion than adding `logicalCount`.
   - Recommendation: add `logicalCount` and keep `count` physical unless a wider migration is explicitly approved.

## Sources

### Primary (HIGH confidence)
- Repo code evidence:
  - `functions/src/addToList.ts`
  - `functions/src/removeFromList.ts`
  - `functions/src/reorderListItems.ts`
  - `functions/src/deleteSubsplashList.ts`
  - `functions/src/helpers/addToListHelpers.ts`
  - `functions/src/DocumentListeners/Lists/listItemOnCreate.ts`
  - `functions/src/DocumentListeners/Lists/listItemOnDelete.ts`
  - `apps/web/pages/admin/lists.tsx`
  - `apps/web/pages/admin/lists/[listId].tsx`
  - `apps/web/components/ListSelector.tsx`
  - `apps/web/utils/algolia/searchRecords.ts`
  - `apps/web/utils/mockAlgoliaSearchClient.ts`
  - `scripts/configure-algolia-list-sorting.mjs`
- Firebase Firestore transactions docs: https://firebase.google.com/docs/firestore/manage-data/transactions
  - Checked guidance that transaction functions may run more than once and should not directly modify application state.
- Algolia `filters` parameter docs: https://www.algolia.com/doc/api-reference/api-parameters/filters/
  - Checked that `filters` apply to attributes declared in `attributesForFaceting`, which matters for a new `isRootList` field.

### Secondary (MEDIUM confidence)
- Firestore query docs: https://firebase.google.com/docs/firestore/query-data/queries
  - Used to confirm collection-group query behavior matches current admin detail-page status lookup patterns.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - verified from `package.json`, workspace manifests, and `pnpm list`.
- Architecture: MEDIUM - codebase evidence is strong, but the write-side Algolia indexing path and remote-only content assumptions are still unclear.
- Pitfalls: HIGH - validated by existing overflow tests plus official Firestore transaction guidance.

**Research date:** 2026-03-14
**Valid until:** 2026-04-13
