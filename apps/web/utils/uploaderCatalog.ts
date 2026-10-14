/** A failed bundle is recoverable; two failed sources are never an empty-success result. */
export async function loadUploaderCatalog<T>(
  bundle: () => Promise<T[]>,
  firestore: () => Promise<T[]>,
  isCurrent: () => boolean = () => true
): Promise<{ ok: true; items: T[] } | { ok: false }> {
  if (!isCurrent()) return { ok: false };
  try {
    return { ok: true, items: await bundle() };
  } catch {
    if (!isCurrent()) return { ok: false };
    try {
      return { ok: true, items: await firestore() };
    } catch {
      return { ok: false };
    }
  }
}

/** Up to 10,000 category entries in 250-document pages, plus one overflow probe.
 * This exceeds the whole known staging catalog; a larger result is an explicit failure,
 * never a partial category menu. Firestore cursors keep each request and response bounded.
 */
export async function readCompleteUploaderCatalog<T, Cursor>(
  readPage: (cursor: Cursor | undefined, count: number) => Promise<{ items: T[]; cursor: Cursor | undefined }>,
  isCurrent: () => boolean = () => true
): Promise<T[]> {
  const items: T[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    if (!isCurrent()) throw new Error('Category catalog load cancelled');
    const count = Math.min(250, 10_001 - items.length);
    const page = await readPage(cursor, count);
    if (page.items.length > count) throw new Error('Invalid catalog page');
    items.push(...page.items);
    if (items.length > 10_000) throw new Error('Category catalog exceeds the complete-load safety budget');
    if (page.items.length < count) return items;
    if (page.cursor === undefined) throw new Error('Category catalog cursor is unavailable');
    cursor = page.cursor;
  }
}

/** Initial defaults may fill an untouched empty selection, but never undo an explicit clear. */
export function applyLatestUploaderDefault<T>(
  previous: T[],
  defaults: T[],
  firstResolvedLoad: boolean,
  destinationsEdited: boolean
): T[] {
  return firstResolvedLoad && !destinationsEdited && previous.length === 0 ? defaults : previous;
}

/** An admitted upload keeps its server-owned intent and source-recovery path. */
export function catalogBlocksNewAdmission(hasReceipt: boolean, unresolved: boolean): boolean {
  return !hasReceipt && unresolved;
}
