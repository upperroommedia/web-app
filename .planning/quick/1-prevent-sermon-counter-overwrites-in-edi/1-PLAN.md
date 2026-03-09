---
phase: quick-1-prevent-sermon-counter-overwrites-in-edit-writes
plan: 1
type: execute
wave: 1
depends_on: []
files_modified:
  - pages/api/editSermon.ts
  - utils/buildEditableSermonPatch.ts
  - functions/src/utils/recalculateSermonCounts.ts
  - functions/src/utils/sermonCountInvariantGuard.ts
  - functions/src/DocumentListeners/SermonLists/sermonListOnCreate.ts
  - functions/src/DocumentListeners/SermonLists/sermonListOnUpdate.ts
  - functions/src/DocumentListeners/SermonLists/sermonListOnDelete.ts
  - functions/src/test/sermonCounts/sermonCountInvariantGuard.test.ts
autonomous: true
requirements:
  - adhoc-sermon-counter-overwrite-guard
  - adhoc-sermon-counter-invariant-autorecalc
user_setup: []
must_haves:
  truths:
    - "Editing a sermon can no longer overwrite listener-owned counter fields on `sermons/{sermonId}`."
    - "If sermon counters become impossible (`uploaded > total` or negative), listeners auto-recalculate from `sermonLists` truth."
    - "Counter drift guard behavior is covered by automated emulator-backed tests."
  artifacts:
    - path: "utils/buildEditableSermonPatch.ts"
      provides: "Explicit allowlist patch for sermon edit writes that excludes counter fields."
      exports: ["buildEditableSermonPatch"]
    - path: "functions/src/utils/sermonCountInvariantGuard.ts"
      provides: "Reusable post-listener invariant check with auto-recalc fallback."
      exports: ["ensureSermonCountInvariant"]
    - path: "functions/src/DocumentListeners/SermonLists/sermonListOnUpdate.ts"
      provides: "Listener-integrated invariant guard after counter deltas."
    - path: "functions/src/test/sermonCounts/sermonCountInvariantGuard.test.ts"
      provides: "Regression tests for invalid/valid counter states."
  key_links:
    - from: "pages/api/editSermon.ts"
      to: "utils/buildEditableSermonPatch.ts"
      via: "updateDoc patch payload"
      pattern: "buildEditableSermonPatch\\(sermon\\)"
    - from: "functions/src/DocumentListeners/SermonLists/sermonListOnCreate.ts"
      to: "functions/src/utils/sermonCountInvariantGuard.ts"
      via: "post-transaction invariant guard"
      pattern: "ensureSermonCountInvariant"
    - from: "functions/src/DocumentListeners/SermonLists/sermonListOnUpdate.ts"
      to: "functions/src/utils/recalculateSermonCounts.ts"
      via: "guard-triggered recalc when invariant fails"
      pattern: "recalculateSermonCounts"
---

<objective>
Prevent sermon counter drift from two directions in one atomic quick fix: edit writes clobbering counters and listener increments drifting into invalid states.

Purpose: Keep `numberOfLists` and `numberOfListsUploadedTo` listener-owned, self-healing, and consistent with `sermons/{sermonId}/sermonLists/*`.
Output: Hardened edit write path plus listener-level invariant guard with automated regression tests.
</objective>

<execution_context>
@/Users/yasaad/.codex/get-shit-done/workflows/execute-plan.md
@/Users/yasaad/.codex/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/debug/inconsistent-sermon-counters.md
@pages/api/editSermon.ts
@utils/buildEditableSermonPatch.ts
@functions/src/DocumentListeners/SermonLists/sermonListOnCreate.ts
@functions/src/DocumentListeners/SermonLists/sermonListOnUpdate.ts
@functions/src/DocumentListeners/SermonLists/sermonListOnDelete.ts
@functions/src/utils/recalculateSermonCounts.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Enforce counter-safe sermon edit writes</name>
  <files>pages/api/editSermon.ts, utils/buildEditableSermonPatch.ts</files>
  <action>
    Make the edit write path explicitly counter-safe and resistant to regression:

    - Keep sermon edit writes on `sermons/{sermonId}` constrained to an allowlist patch (`buildEditableSermonPatch`) only.
    - Ensure `numberOfLists` and `numberOfListsUploadedTo` are never part of edit payload construction.
    - Add/keep inline guard comments in patch builder clarifying these counters are listener-owned and must not be written by edit flows.
    - If any remaining edit path writes whole-sermon objects to `sermons/{sermonId}`, refactor it to use the same allowlist patch pattern.

    Safety:
    - Do not change create/upload flows that initialize new sermon docs.
    - Do not change publish status mutation behavior except where needed to remove counter-overwrite risk.
  </action>
  <verify>
    <automated>pnpm exec tsc --noEmit && rg -n "buildEditableSermonPatch\\(sermon\\)" pages/api/editSermon.ts && ! rg -n "numberOfLists\\s*:|numberOfListsUploadedTo\\s*:" utils/buildEditableSermonPatch.ts</automated>
  </verify>
  <done>
    Edit writes to sermon docs cannot directly overwrite counter fields, and the allowlist patch remains the single counter-safe write contract.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add listener invariant auto-recalc guard with regression tests</name>
  <files>functions/src/utils/sermonCountInvariantGuard.ts, functions/src/utils/recalculateSermonCounts.ts, functions/src/DocumentListeners/SermonLists/sermonListOnCreate.ts, functions/src/DocumentListeners/SermonLists/sermonListOnUpdate.ts, functions/src/DocumentListeners/SermonLists/sermonListOnDelete.ts, functions/src/test/sermonCounts/sermonCountInvariantGuard.test.ts</files>
  <behavior>
    - Test 1: when sermon counters are valid after listener delta, guard does not rewrite counts.
    - Test 2: when counters violate invariant (`numberOfListsUploadedTo > numberOfLists`), guard triggers recalc from subcollection truth.
    - Test 3: when counters are negative, guard triggers recalc and persists corrected non-negative totals.
  </behavior>
  <action>
    Implement a shared post-listener guard and wire it into all sermon-list counter mutation listeners:

    - Create `ensureSermonCountInvariant(sermonId)` in `functions/src/utils/sermonCountInvariantGuard.ts`.
    - Guard logic:
      - Read current sermon counters.
      - If `numberOfLists < 0`, `numberOfListsUploadedTo < 0`, or `numberOfListsUploadedTo > numberOfLists`, call `recalculateSermonCounts` to repair from `sermonLists`.
      - Log structured metadata when a repair is triggered (sermonId, before, after, reason).
    - Wire guard invocation after successful counter mutation in:
      - `sermonListOnCreate.ts`
      - `sermonListOnUpdate.ts`
      - `sermonListOnDelete.ts`
    - Keep listener behavior fail-safe: if recalc fails, surface error through existing error handling; do not silently swallow invariant failures.

    Testing:
    - Add focused emulator-backed tests for invariant guard behaviors in `functions/src/test/sermonCounts/sermonCountInvariantGuard.test.ts`.
    - Use seeded sermon + sermonLists fixtures to prove recalculation uses subcollection truth, not arithmetic assumptions.
  </action>
  <verify>
    <automated>cd functions && firebase emulators:exec --only firestore --config ../firebase.test.json "pnpm exec jest --runInBand --forceExit src/test/sermonCounts/sermonCountInvariantGuard.test.ts" && pnpm exec tsc --noEmit</automated>
  </verify>
  <done>
    Listener counter mutations are now guarded by an automatic invariant repair path, and tests cover valid vs invalid counter states.
  </done>
</task>

</tasks>

<verification>
- `pnpm exec tsc --noEmit` passes at repo root.
- `cd functions && pnpm exec tsc --noEmit` passes.
- `cd functions && firebase emulators:exec --only firestore --config ../firebase.test.json "pnpm exec jest --runInBand --forceExit src/test/sermonCounts/sermonCountInvariantGuard.test.ts"` passes.
</verification>

<success_criteria>
- No sermon edit flow writes `numberOfLists` or `numberOfListsUploadedTo` directly.
- Sermon list listeners auto-repair impossible counter states without manual callable invocation.
- Automated tests fail if invariant guard is removed or if invalid states no longer trigger recalculation.
</success_criteria>

<output>
After completion, create `.planning/quick/1-prevent-sermon-counter-overwrites-in-edi/1-SUMMARY.md`
</output>
