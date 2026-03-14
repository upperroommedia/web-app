# Deferred Items

- `pnpm --dir functions exec tsc --noEmit` currently fails outside this plan in `functions/src/test/lists/reorderListItems.test.ts` because it imports `ReorderListItemsInputType` and `ReorderListItemsOutputType` as named exports from `../../reorderListItems`, but that module does not export those names. This plan did not touch reorder behavior, so the issue was left deferred.
