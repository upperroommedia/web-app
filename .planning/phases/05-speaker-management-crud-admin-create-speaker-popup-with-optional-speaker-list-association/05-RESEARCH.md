# Phase 5: Speaker Management CRUD + Admin Create Speaker Popup with Optional Speaker List Association - Research

**Researched:** 2026-03-10
**Domain:** Admin speaker lifecycle management (Firestore + callable backend + optional Subsplash list creation)
**Confidence:** MEDIUM

## Summary

This phase should be planned as one new backend callable command surface plus one new admin popup flow on `pages/admin/speakers.tsx`. The codebase already has speaker read/listing UI, image selection/upload UX (`ImageViewer` + `ImageSelector`), list creation primitives (`createNewSubsplashList`), and lock/idempotency utilities (`withSubsplashLocks`, `withIdempotency`). The missing piece is a consistent mutation boundary for speaker create/update/delete and optional list association.

The safest approach is to make a single callable (command-style CRUD) the source of truth for mutations, and stop adding direct client writes for new speaker lifecycle paths. For optional speaker-list association, reuse existing list creation behavior and set `ListType.SPEAKER_LIST`, storing `speaker.listId` and `list.subsplashId` together in one transactional flow where possible.

A strict UX requirement from scope must be treated as contract-level acceptance criteria: when a speaker list is created, show a success popup containing the exact provided URL and instruction text (verbatim, including spelling).

**Primary recommendation:** Implement `managespeaker` callable commands (`create`, `update`, `delete`) with idempotency + lock metadata support, wire a new `Create Speaker` popup at the top of `/admin/speakers`, and keep the optional list-association + success-popup copy as explicit non-negotiable output behavior.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `firebase-functions` | `^7.1.0` (catalog) | Callable backend mutation boundary (`onCall`, `HttpsError`) | Existing backend contract for all admin mutations |
| `firebase-admin` | `^13.7.0` (catalog) | Firestore transactional writes from backend | Existing authoritative server write path |
| `axios` | `^1.13.6` (catalog) | Subsplash API calls from Functions | Already used by all Subsplash integrations |
| `next` | `16.1.6` | Admin page integration (`pages/admin/speakers.tsx`) | Current app runtime |
| `@mui/material` | `^7.1.1` | Popup/form/button UX (Dialog-based) | Existing design system in admin pages |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `react` / `react-dom` | `19.2.4` | Popup state + optimistic UI updates | Admin speaker page and table updates |
| Existing lock/idempotency utilities | in-repo (`functions/src/locks/*`) | Concurrency-safe, retry-safe mutations | Any command that touches Subsplash/list writes |
| Existing image selection stack | in-repo (`components/ImageViewer.tsx`, `components/ImageSelector.tsx`) | Select/upload square/wide/banner images | Create/edit speaker popup image fields |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Single command callable (`managespeaker`) | Separate callables (`createspeaker`, `updatespeaker`, `deletespeaker`) | Separate endpoints are simpler to reason about, but the prompt explicitly asks for CRUD commands; command API matches requirement wording |
| Backend mutations (selected) | Keep direct client `updateDoc` writes | Client-direct writes are harder to enforce for cross-resource operations (speaker + list + optional Subsplash side effects) |
| Reuse existing popup/image primitives (selected) | Build new custom modal/image flow | Adds UI debt and duplicates behavior already used in lists/speaker details |

**Installation:**
```bash
# No new dependencies required for baseline Phase 5 implementation.
```

## Architecture Patterns

### Recommended Project Structure
```text
functions/src/
├── speakers/
│   ├── manageSpeaker.ts            # onCall command handler (create/update/delete)
│   ├── speakerTypes.ts             # command payload/result types
│   └── speakerMutations.ts         # Firestore + optional list/subsplash orchestration
└── index.ts                        # exports.managespeaker = managespeaker

components/
├── CreateSpeakerPopup.tsx          # new popup with speaker form + optional create-list toggle
└── SpeakerTable.tsx                # toolbar button integration + post-create refresh

pages/admin/
└── speakers.tsx                    # owns popup open/close and list refresh
```

### Pattern 1: Command-Style Callable Contract
**What:** One callable with discriminated command payloads (`create`/`update`/`delete`).
**When to use:** All speaker mutations from admin page.
**Example:**
```typescript
// Source: firebase callable patterns
// https://firebase.google.com/docs/functions/callable
// Source pattern in repo: functions/src/createSeries.ts

type ManageSpeakerCommand =
  | {
      command: 'create';
      speaker: {
        name: string;
        images: ImageType[];
        sermonCount?: number;
      };
      createSpeakerList?: boolean;
      operationKey?: string;
    }
  | {
      command: 'update';
      speakerId: string;
      patch: Partial<Pick<ISpeaker, 'name' | 'images' | 'listId'>>;
      operationKey?: string;
    }
  | {
      command: 'delete';
      speakerId: string;
      deleteAssociatedList?: boolean;
      operationKey?: string;
    };
```

### Pattern 2: Single Create Flow With Optional List Association
**What:** For `create` command, write speaker record and (if selected) create list + attach `listId` in same logical operation.
**When to use:** Admin creates a new speaker from popup.
**Example:**
```typescript
// Source pattern in repo: functions/src/createNewSubsplashList.ts
// Source model: types/List.ts (ListType.SPEAKER_LIST)

const squareImage = input.speaker.images.find((img) => img.type === 'square');
if (!squareImage) {
  throw new HttpsError('invalid-argument', 'A square image is required.');
}

if (input.createSpeakerList) {
  const { listId: subsplashListId } = await createNewSubsplashList({
    title: input.speaker.name,
    images: [squareImage],
    operationKey,
  });

  // Persist Firestore list doc as speaker-list and attach to speaker.listId.
  // Keep list.images aligned with square image used in Subsplash create call.
}
```

### Pattern 3: Strict UI Contract for Success Popup
**What:** Show exact URL + exact instruction string when list is created.
**When to use:** Create command returns `speakerListCreated === true`.
**Example:**
```typescript
const SUBSPLASH_LIST_LINK =
  'https://dashboard.subsplash.com/-d/#/library/lists/standard/2d040f78-a3e1-447a-b5b3-5e80b608dbc6';

const INSTRUCTION =
  'Your speaker list was created sucessfully - please following the subsplash link and add the newly created list to the correct location to the speakers list if you want it to appear there in the app.';
```

### Pattern 4: Reuse Existing Lock/Idempotency Metadata Path
**What:** Accept `operationKey` and pass into lock/idempotency wrappers when remote list operations occur.
**When to use:** Create/update/delete commands that call Subsplash endpoints.
**Example:**
```typescript
// Source pattern in repo: functions/src/createSeries.ts, functions/src/createNewSubsplashList.ts
return withIdempotency(operationKey, async () =>
  withSubsplashLocks(lockKeys, async () => runMutation(), { operationKey })
);
```

### Anti-Patterns to Avoid
- **Client-only mutation orchestration:** Do not keep adding multi-step create logic in React components.
- **Best-effort partial creates without contract:** Avoid creating list remotely and then silently failing speaker write.
- **Square-image fallback guessing:** Do not implicitly map non-square images when scope requires square for speaker tag/list.
- **Copy drift in success text:** Treat provided URL/instruction as exact contract copy, not editable UX text.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Popup/dialog infrastructure | New custom modal framework | Existing `components/PopUp.tsx` | Already standardized and used across admin UI |
| Image upload/selection widgets | New file-picker pipeline | `ImageViewer` + `ImageSelector` | Reuses existing image storage/index flow (`speaker-images/*`) |
| Subsplash list creation payload rules | New ad hoc list API module | `createNewSubsplashList` helper/callable logic | Existing app_key/payload format and lock/idempotency usage |
| Concurrency/error response format | New busy/error schema | Existing lock/idempotency + `HttpsError` conventions | Keeps retry/busy behavior consistent with admin publish flows |

**Key insight:** Most complexity in this phase is orchestration and consistency, not UI controls. Reusing current primitives is lower risk than introducing new infrastructure.

## Common Pitfalls

### Pitfall 1: Partial Success Between List and Speaker Writes
**What goes wrong:** Subsplash list is created, but Firestore speaker/list linkage fails, leaving orphan remote state.
**Why it happens:** Multi-system writes without clear commit/rollback strategy.
**How to avoid:** Return structured result with explicit `speakerCreated`, `listCreated`, `rollbackAttempted` fields and log failures; use Firestore transaction for local writes.
**Warning signs:** Speaker missing `listId` while remote list exists.

### Pitfall 2: Missing or Invalid Square Image Mapping
**What goes wrong:** List/speaker image behavior diverges from requirement.
**Why it happens:** UI allows submit without square image or backend does not enforce.
**How to avoid:** Validate on both client and callable; require square image and pass it to both speaker tag/list payloads.
**Warning signs:** Newly created speaker/list shows wrong image type or no image.

### Pitfall 3: Duplicate Speaker Names and Ambiguous Tag/List Mapping
**What goes wrong:** Two speakers with same name collide in downstream assumptions (search/list/title).
**Why it happens:** No uniqueness check before create.
**How to avoid:** Add normalized-name duplicate guard in callable (`trim().toLowerCase()`) with actionable error.
**Warning signs:** Algolia search returns indistinguishable speaker entries.

### Pitfall 4: No Regression Coverage for Speaker Admin Flow
**What goes wrong:** CRUD behavior regresses silently (especially optional list path).
**Why it happens:** Current repo has no meaningful speaker-specific test coverage.
**How to avoid:** Add new function tests for each command path and at least one UI integration test for popup create flow.
**Warning signs:** Manual-only validation and repeated break/fix cycles.

### Pitfall 5: Hidden Contract Drift in Success Popup Copy
**What goes wrong:** Slight text or URL edits break stakeholder requirement.
**Why it happens:** Copy treated as normal UX text.
**How to avoid:** Store link + instruction as constants and assert them in UI tests.
**Warning signs:** PRs changing punctuation/spelling in required copy.

## Code Examples

Verified patterns from official and repo sources:

### Callable Command Wrapper (v2)
```typescript
// Source: https://firebase.google.com/docs/functions/callable
// Source: functions/src/createSeries.ts
import { onCall, HttpsError } from 'firebase-functions/v2/https';

export default onCall(async (request) => {
  if (!request.auth?.token?.role) {
    throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }

  const data = request.data;
  if (!data?.command) {
    throw new HttpsError('invalid-argument', 'command is required.');
  }

  switch (data.command) {
    case 'create':
      return handleCreate(data);
    case 'update':
      return handleUpdate(data);
    case 'delete':
      return handleDelete(data);
    default:
      throw new HttpsError('invalid-argument', `Unsupported command: ${data.command}`);
  }
});
```

### Firestore Transaction Guard for Multi-Doc Local Writes
```typescript
// Source: https://firebase.google.com/docs/firestore/manage-data/transactions
await firestore.runTransaction(async (tx) => {
  const speakerRef = firestore.collection('speakers').doc(speakerId);
  const existing = await tx.get(speakerRef);
  if (existing.exists) {
    throw new HttpsError('already-exists', 'Speaker already exists.');
  }

  tx.set(speakerRef, speakerPayload);
  if (listRef) {
    tx.set(listRef, listPayload, { merge: true });
  }
});
```

### Admin Speakers Top-Button Integration Pattern
```tsx
// Source pattern: pages/admin/lists.tsx (header action button)
<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
  <Typography variant="h4" fontWeight={700}>Manage Speakers</Typography>
  <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateSpeakerPopup(true)}>
    Add Speaker
  </Button>
</Box>
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Speaker mutations done directly from client Firestore writes (`updateDoc` in table/details flows) | Server-owned callable mutation boundary with command semantics | Phase 5 target | Better consistency, auditability, and multi-resource safety |
| Speaker list link behavior mostly inherited from imported Subsplash data | Explicit optional list creation during speaker create | Phase 5 target | Predictable onboarding for new speakers |
| Ad hoc admin alerts for side effects | Structured create response + required success popup contract | Phase 5 target | Clear operator guidance and deterministic UX |

**Deprecated/outdated:**
- Adding new speaker lifecycle behavior via direct client Firestore writes.
- Treating success link/instruction copy as editable content.

## Open Questions

1. **Subsplash speaker-tag CRUD endpoint contract is not publicly verifiable from docs accessible without developer portal access.**
   - What we know: Existing code reads speaker tags from `tags/v1/tags` in scraper flows and writes sermon speaker tags by name during media publish.
   - What's unclear: Confirmed create/update/delete endpoint and payload for speaker tag objects (including image assignment).
   - Recommendation: Add a Wave 0 API validation task against current Subsplash credentials; if unavailable, ship Phase 5 with Firestore speaker CRUD + optional list creation and mark tag CRUD as follow-up.

2. **Delete semantics for associated speaker list are not specified in scope.**
   - What we know: Scope asks for optional association at create time, not delete policy.
   - What's unclear: Whether deleting a speaker should also delete linked list locally/remotely.
   - Recommendation: Default to non-destructive delete (remove speaker only, keep list) unless explicit product decision says cascade.

3. **Search indexing latency/consistency after speaker create is unspecified.**
   - What we know: Admin speaker search uses Algolia index `speakers`.
   - What's unclear: SLA for new speaker visibility in Algolia and fallback behavior.
   - Recommendation: After create success, optimistically append created speaker to local table state and avoid hard dependency on immediate Algolia sync.

## Sources

### Primary (HIGH confidence)
- Repository source of truth:
  - `pages/admin/speakers.tsx`
  - `components/SpeakerTable.tsx`
  - `components/NewListPopup.tsx`
  - `components/PopUp.tsx`
  - `components/ImageViewer.tsx`
  - `components/ImageSelector.tsx`
  - `functions/src/createNewSubsplashList.ts`
  - `functions/src/createSeries.ts`
  - `functions/src/locks/withSubsplashLocks.ts`
  - `functions/src/locks/withIdempotency.ts`
  - `types/Speaker.ts`
  - `types/List.ts`
- Firebase callable functions docs: https://firebase.google.com/docs/functions/callable
- Firestore transactions docs: https://firebase.google.com/docs/firestore/manage-data/transactions
- MUI Dialog docs (used by popup wrapper): https://mui.com/material-ui/react-dialog/

### Secondary (MEDIUM confidence)
- Subsplash support article (tag behavior context): https://support.subsplash.com/en/articles/3108994-how-do-i-add-or-remove-tags-from-media-items
- Subsplash API support landing: https://support.subsplash.com/en/articles/1108966-how-do-i-get-started-with-api

### Tertiary (LOW confidence)
- Assumption that speaker-tag CRUD is available via private Subsplash developer endpoints (not verifiable from public docs without portal access).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - versions and libraries are confirmed in workspace manifests and active code.
- Architecture: MEDIUM - local architecture is clear, but speaker-tag CRUD external endpoint details are not publicly confirmed.
- Pitfalls: MEDIUM - pitfalls are strongly supported by current code patterns, but some downstream product decisions are still open.

**Research date:** 2026-03-10
**Valid until:** 2026-03-24
