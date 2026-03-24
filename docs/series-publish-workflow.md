# Series Publish Workflow

This workflow supports three publish paths:

- `Publish to Subsplash`: publishes sermon media to selected list(s) only.
- `Publish to Series`: publishes sermon media to a Subsplash series only.
- `Publish Everywhere`: convenience action that runs list publish and series publish in one flow.

Series publishing is intentionally independent from list publishing. A sermon can be added to a series as long as it has a valid `sermon.subsplashId` (media item exists in Subsplash).

## Strict Published Count Semantics

Series metadata is strict:

- Counted as published: `publishedToSubsplash === true`
- Not counted as published: `false`, `null`, or missing `publishedToSubsplash`
- No runtime fallback from `sermonSubsplashId` is used for published counts

## Legacy Backfill Script

Use the script to reconcile existing `series/{seriesId}/seriesItems/{itemId}` docs against actual Subsplash series membership.

Script path:
- `scripts/backfillSeriesPublishedFlags.ts`

### Prerequisites

- Firebase Admin credentials available in the current shell (standard project setup).
- Subsplash credentials exported:
  - `SUBSPLASH_EMAIL`
  - `SUBSPLASH_PASSWORD`

### Dry-run (default)

```bash
npx ts-node --skip-project scripts/backfillSeriesPublishedFlags.ts
```

Optional scope:

```bash
npx ts-node --skip-project scripts/backfillSeriesPublishedFlags.ts --series-id=<firestoreSeriesId>
npx ts-node --skip-project scripts/backfillSeriesPublishedFlags.ts --limit=<number>
```

Dry-run prints a JSON summary with:
- number of series scanned
- total item docs scanned
- mismatches detected
- preview of proposed changes (`changePreviewCount` and `preview`)

### Apply mode

```bash
npx ts-node --skip-project scripts/backfillSeriesPublishedFlags.ts --apply
```

Apply mode updates only mismatched docs by setting `publishedToSubsplash` to the membership-truth value. If a doc already matches, it is skipped. The script is idempotent.

## Manual QA Checklist

Run these checks from the Manage Publishing popup:

1. Series-only publish without list publish:
   - Use a sermon with `subsplashId` present and zero list publications.
   - Click `Publish to Series`.
   - Confirm success and `seriesItems/{sermonId}.publishedToSubsplash === true`.
2. Lists-only publish:
   - Click `Publish to Subsplash` with one or more lists selected.
   - Confirm list upload statuses become uploaded.
   - Confirm no unintended series publish occurs.
3. Combined publish:
   - Click `Publish Everywhere` with a sermon that has a `seriesId`.
   - Confirm list publish and series publish both execute.
   - If one side fails, confirm partial-failure messaging identifies which side failed.
4. Unpublish decoupling:
   - Remove from series and confirm list statuses do not change.
   - Remove from list(s) and confirm series publish flag does not change.
