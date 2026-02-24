# Phase 01: Series Subtitle Automation - Context

**Gathered:** 2026-02-24
**Status:** Ready for planning
**Source:** User request via `$gsd-plan-phase`

<domain>
## Phase Boundary

Replace custom series subtitle authoring with an automatically derived subtitle based on published items only.

Expected subtitle format:
- `x part series`
- Example: `5 part series`

Counting rule:
- Count only items that are published to series (published-to-Subsplash association), not total series items.
- Example: 10 items total, 5 published -> subtitle must be `5 part series`.

Primary surface called out: `pages/admin/series.tsx` and related series flows.

</domain>

<decisions>
## Implementation Decisions

### Locked Decisions
- Remove user ability to set/edit custom series subtitle.
- Subtitle must be machine-derived from published series items.
- Published count is the sole source for subtitle number.
- Subtitle format is exactly `x part series`.

### Claude's Discretion
- Where derived subtitle is computed and persisted (client-derived vs server-derived canonical source).
- Whether/how to backfill existing series with stale custom subtitles.
- Which tests are added at unit/integration/E2E layers for sufficient regression coverage.

</decisions>

<specifics>
## Specific Ideas

- Current model has both `itemCount` and `publishedItemCount` in `types/Series.ts`.
- Series item publish status exists at `series/{seriesId}/seriesItems/{sermonId}.publishedToSubsplash`.
- Current subtitle entry/edit UI exists in `components/NewSeriesPopup.tsx`.

</specifics>

<deferred>
## Deferred Ideas

- Broader series metadata redesign beyond subtitle/count derivation.
- Non-series subtitle systems (sermon/list subtitles) unless required for this change.

</deferred>

---

*Phase: 01-series-subtitle-automation*
*Context gathered: 2026-02-24*
