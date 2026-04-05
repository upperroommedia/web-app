# Holy Week Flow

## Summary

Holy Week uploads are handled as a special uploader flow under the `Pascha Sermons` subtitle.

The uploader does not publish to the generic `Pascha Sermons` category list. Instead, it writes exactly two Holy Week tagged lists onto the sermon:

- one Holy Week year list
- one Holy Week day list

Those two lists drive the downstream publish behavior to Subsplash.

## User Flow

In the uploader:

- select subtitle `Pascha Sermons`
- two additional dropdowns appear
- the left dropdown is `Pascha Year`
- the right dropdown is `Holy Week Day`

Both fields are required before upload/save succeeds.

If the user changes away from `Pascha Sermons`, the Holy Week selections are cleared and Holy Week tagged lists are removed from the working sermon list.

If the user is editing an existing Holy Week sermon, the uploader prefills the selected year/day lists from the current sermon lists and normalizes the list state so the generic `Pascha Sermons` category list is not kept alongside the Holy Week targets.

## Final Sermon List Behavior

When `Pascha Sermons` is active:

- the generic `Pascha Sermons` category list is removed from `sermonList`
- the selected Holy Week year list is added
- the selected Holy Week day list is added

The desired final state is:

- `sermon.subtitle === 'Pascha Sermons'`
- `sermonList` contains the chosen Holy Week year list
- `sermonList` contains the chosen Holy Week day list
- `sermonList` does not contain the generic `Pascha Sermons` category list

## Data Model

Holy Week is represented as tagged Firebase `lists` documents.

Shared list metadata now supports:

- `ListTag.HOLY_WEEK`
- `HolyWeekKind.YEAR`
- `HolyWeekKind.DAY`
- `HolyWeekDay`

The Holy Week day enum is ordered as:

1. `PALM_SUNDAY`
2. `HOLY_MONDAY`
3. `HOLY_TUESDAY`
4. `HOLY_WEDNESDAY`
5. `COVENANT_THURSDAY`
6. `GOOD_FRIDAY`
7. `JOYOUS_SATURDAY`
8. `RESURRECTION`

Holy Week lists are stored as normal `lists` docs with `listTagAndPosition` set to one of:

```ts
{
  listTag: ListTag.HOLY_WEEK,
  holyWeekKind: HolyWeekKind.YEAR,
  position: number,
  year: number,
}
```

or

```ts
{
  listTag: ListTag.HOLY_WEEK,
  holyWeekKind: HolyWeekKind.DAY,
  position: number,
  day: HolyWeekDay,
}
```

## Bundles

Holy Week uses the normal tagged-list bundle system.

The shared/frontend bundle config is `HOLY_WEEK_BUNDLE_CONFIG` and is wired like the other list bundle families:

- `bundleType: 'holy-week'`
- `functionName: 'createholyweekbundle'`
- `metadataDocPath: 'bundle-metadata/holy-week-bundle'`
- `bundlePath: 'bundles/holy-week-bundle.bin'`
- Firestore query filter:
  - `where('listTagAndPosition.listTag', '==', ListTag.HOLY_WEEK)`

### Bundle creation and serving

Holy Week bundle creation is exposed by:

- `functions/src/createHolyWeekBundle.ts`
- exported from `functions-core/src/index.ts` as `createholyweekbundle`

The frontend loads Holy Week lists through:

- `apps/web/utils/bundleHelpers.ts`
- `getHolyWeekListsFromBundle()`

If bundle loading fails, the selector falls back to a Firestore query on `lists` filtered by `listTagAndPosition.listTag == HOLY_WEEK`.

### Bundle invalidation

Holy Week list writes invalidate/regenerate through:

- `functions/src/DocumentListeners/Lists/taggedListOnWrite.ts`
- exported from `functions-core/src/index.ts` as `holyweeklistonwrite`

Any meaningful change to a Holy Week tagged list should cause the Holy Week bundle to refresh through the same bundle listener pattern used by Bible Chapter and Sunday Homily tagged lists.

## Admin Backfill

Holy Week setup depends on a one-off admin backfill callable:

- function name: `backfillholyweeklists`
- implementation: `functions/src/backfillHolyWeekLists.ts`
- contract: `packages/contracts/backfillHolyWeekLists.ts`
- UI entry point: `apps/web/pages/admin/advanced.tsx`

### Access control

Only the verified script runner user can execute the callable:

- `youssef.a.asaad@gmail.com`

The callable checks:

- authenticated user exists
- auth token email matches the expected email
- Firebase Auth canonical email matches the expected email
- Firebase Auth `emailVerified === true`

### Year list source

Holy Week year lists are discovered only from this Subsplash source list:

- source list id: `0ac1575c-2508-4c06-882c-b6df30c2bca0`
- source dashboard URL:
  - `https://dashboard.subsplash.com/-d/#/library/lists/standard/0ac1575c-2508-4c06-882c-b6df30c2bca0`

The callable queries Subsplash list rows under that source list, fetches each child list, and parses titles using:

- `^Pascha Week (\\d{4})$`

Important:

- only children returned from that parent query are considered valid year targets
- duplicate years are reported and excluded from the unique year sync set
- invalid titles are reported and skipped

### Fixed Holy Week day lists

The callable also upserts and tags the eight fixed Holy Week day lists:

- Palm Sunday: `2b21287e-fdc3-42a2-87b5-bd9f33fd2958`
- Holy Monday: `b2650da0-0f41-4863-890a-4e572c547b38`
- Holy Tuesday: `65ae89c9-096b-4ba7-84a3-f837dd35c08d`
- Holy Wednesday: `27547956-088a-4a71-92d7-1d03968a1353`
- Covenant Thursday: `87216c9c-7594-4cc2-88a5-30d3c99f96bc`
- Good Friday: `8c1cfe2b-0c88-4d0e-8801-44386ed1755d`
- Joyous Saturday: `7cd2e05b-c93f-40be-bd8c-07de09c746b4`
- Resurrection: `dc86bd07-c1ef-40d4-8d0c-9f2c553f6bb1`

### Callable result

The admin result includes:

- source list id
- total year rows
- created year list count
- updated year list count
- skipped year list count
- tagged day list count
- duplicate years
- invalid titles
- processed year lists
- processed day lists

The Advanced Admin page surfaces the result as summary chips plus warning cards for:

- duplicate years
- invalid titles

## Sorting Rules

The uploader sorts:

- Holy Week years descending by numeric year
- Holy Week days by fixed liturgical order, not alphabetically

Friendly day labels shown in the UI:

- Palm Sunday
- Holy Monday
- Holy Tuesday
- Holy Wednesday
- Covenant Thursday
- Good Friday
- Joyous Saturday
- Resurrection

## Files Involved

Primary implementation files:

- `apps/web/components/uploaderComponents/UploaderComponent.tsx`
- `apps/web/components/uploaderComponents/HolyWeekSelector.tsx`
- `apps/web/components/uploaderComponents/consts.ts`
- `apps/web/utils/holyWeek.ts`
- `apps/web/utils/bundleHelpers.ts`
- `apps/web/shared/bundleConfigs.ts`
- `apps/web/pages/admin/advanced.tsx`
- `packages/shared/types/List.ts`
- `packages/shared/shared/bundleConfigs.ts`
- `packages/contracts/backfillHolyWeekLists.ts`
- `functions/src/backfillHolyWeekLists.ts`
- `functions/src/createHolyWeekBundle.ts`
- `functions/src/DocumentListeners/Lists/taggedListOnWrite.ts`
- `functions-core/src/index.ts`
- `functions-integrations/src/index.ts`

## How To Use It

### Initial setup

1. Run the Holy Week backfill from the Advanced Admin page as the authorized script runner.
2. Confirm the backfill result reports the expected year/day lists.
3. Confirm the Holy Week bundle can be generated and served.

### Uploading a Holy Week sermon

1. Open the uploader.
2. Choose subtitle `Pascha Sermons`.
3. Choose a `Pascha Year`.
4. Choose a `Holy Week Day`.
5. Upload or save the sermon.

### What to verify after upload

Verify that the saved sermon lists include:

- the selected Holy Week year list
- the selected Holy Week day list

Verify that the saved sermon lists do not include:

- the generic `Pascha Sermons` category list

## Local Testing Notes

For local testing with real Subsplash instead of the mock/dev behavior, the local environment needs valid Subsplash credentials in `.env`:

- `SUBSPLASH_EMAIL`
- `SUBSPLASH_PASSWORD`

The local uploader behavior is then:

- Next.js app runs locally
- Firebase emulators run locally
- Subsplash calls use the real credentials from the local environment

## Known Naming Distinction

There are two similar but different names in this flow:

- uploader subtitle: `Pascha Sermons`
- Subsplash year list title pattern: `Pascha Week YYYY`

That distinction is intentional in the current implementation.
