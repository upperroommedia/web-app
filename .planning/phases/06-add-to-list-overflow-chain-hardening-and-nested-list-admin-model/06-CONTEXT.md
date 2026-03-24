# Phase 6: Add-to-list overflow chain hardening and nested list admin model - Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Make add-to-list overflow behavior robust and predictable while preserving a single main-list operator model in admin surfaces. This phase covers how overflow pages are represented, surfaced, and managed for admins and uploaders; it does not add new content-management capabilities beyond clarifying the existing root-list plus overflow-chain behavior.

</domain>

<decisions>
## Implementation Decisions

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

</decisions>

<specifics>
## Specific Ideas

- The admin experience should avoid mirroring Subsplash page segmentation too literally because showing only the first 199 items and making admins inspect linked overflow pages would be confusing.
- The preferred admin model is a single long logical list in the UI, while the system handles the underlying Subsplash pagination and constraints behind the scenes.
- Overflow metadata visibility is for admins only.
- Overflow pages should remain recognizable as continuation pages named `More {root list name} sermons`.

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/web/pages/admin/lists/[listId].tsx`: existing list detail page that can become the aggregated root-list operator surface.
- `apps/web/components/ListSelector.tsx`: existing list picker used by uploader/admin flows; currently a key enforcement point for root-only list discovery.
- `apps/web/utils/algolia/searchRecords.ts`: existing admin list search adapter already applies query-time Algolia filtering and can be aligned to a stronger root-only field.
- `apps/web/pages/admin/sermons/[sermonId].tsx`: existing publish/remove flow for sermon-list membership; important integration point for logical-list semantics.
- `functions/src/addToList.ts` and `functions/src/removeFromList.ts`: existing overflow-chain mutation logic and recovery behavior.

### Established Patterns
- Lists are stored as top-level Firestore documents with local Firestore IDs and optional remote `subsplashId` linkage.
- Current overflow/root distinction is inferred through optional `isMoreSermonsList` and `moreSermonsRef`, which is why some Firebase reads fall back to post-fetch filtering.
- Local sermon membership is tracked in `lists/{listId}/listItems` and mirrored in `sermons/{sermonId}/sermonLists`, while the remote overflow chain is managed through Subsplash list rows.
- Locking/idempotency patterns already exist around Subsplash-linked list mutations and should remain part of any robust overflow-chain handling.

### Integration Points
- Frontend: `apps/web/components/uploaderComponents/UploaderComponent.tsx`, `apps/web/components/ListSelector.tsx`, `apps/web/pages/admin/lists.tsx`, and `apps/web/pages/admin/lists/[listId].tsx`.
- Admin sermon membership sync: `apps/web/pages/admin/sermons/[sermonId].tsx`, `apps/web/pages/api/uploadFile.tsx`, and `apps/web/pages/api/editSermon.ts`.
- Backend list mutation/import/delete paths: `functions/src/addToList.ts`, `functions/src/removeFromList.ts`, `functions/src/deleteSubsplashList.ts`, and `functions/src/Scrapers/populateListsHelper.ts`.

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 06-add-to-list-overflow-chain-hardening-and-nested-list-admin-model*
*Context gathered: 2026-03-14*
