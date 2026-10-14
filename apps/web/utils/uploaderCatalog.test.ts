import {
  applyLatestUploaderDefault,
  loadUploaderCatalog,
  readCompleteUploaderCatalog,
  catalogBlocksNewAdmission,
} from './uploaderCatalog';

describe('recoverable complete uploader catalog lookup', () => {
  it('uses real fallback data after bundle failure, but never treats two failures as empty success', async () => {
    const fallback = jest.fn(async () => ['category']);
    expect(
      await loadUploaderCatalog(async () => {
        throw new Error('bundle unavailable');
      }, fallback)
    ).toEqual({ ok: true, items: ['category'] });
    expect(fallback).toHaveBeenCalledTimes(1);
    await expect(
      loadUploaderCatalog(
        async () => {
          throw new Error('bundle');
        },
        async () => {
          throw new Error('firestore');
        }
      )
    ).resolves.toEqual({ ok: false });
  });
  it('treats successful empty results as resolved and does not call fallback', async () => {
    const fallback = jest.fn(async () => ['unexpected']);
    expect(await loadUploaderCatalog(async () => [], fallback)).toEqual({ ok: true, items: [] });
    expect(fallback).not.toHaveBeenCalled();
  });
  it('does not serialize unrelated category and default lookups', async () => {
    let finish!: (value: string[]) => void;
    const slow = new Promise<string[]>((resolve) => {
      finish = resolve;
    });
    const categories = loadUploaderCatalog(
      () => slow,
      async () => []
    );
    expect(
      await loadUploaderCatalog(
        async () => ['latest'],
        async () => []
      )
    ).toEqual({ ok: true, items: ['latest'] });
    finish(['category']);
    expect(await categories).toEqual({ ok: true, items: ['category'] });
  });
  it('loads a catalog larger than 2k documents through bounded complete pages', async () => {
    const values = Array.from({ length: 2501 }, (_, i) => i);
    const read = jest.fn(async (cursor: number | undefined, count: number) => ({
      items: values.slice(cursor ?? 0, (cursor ?? 0) + count),
      cursor: (cursor ?? 0) + count,
    }));
    expect(await readCompleteUploaderCatalog(read)).toEqual(values);
    expect(read).toHaveBeenCalledTimes(11);
    expect(read.mock.calls.every(([, count]) => count <= 250)).toBe(true);
  });
  it('does not return an incomplete catalog beyond the overall budget or after a page failure', async () => {
    const endless = jest.fn(async (cursor: number | undefined, count: number) => ({
      items: Array(count).fill('entry'),
      cursor: (cursor ?? 0) + count,
    }));
    await expect(readCompleteUploaderCatalog(endless)).rejects.toThrow('safety budget');
    expect(endless).toHaveBeenCalledTimes(41);
    await expect(
      readCompleteUploaderCatalog(async () => {
        throw new Error('page unavailable');
      })
    ).rejects.toThrow('page unavailable');
  });
  it('supports the exact budget only after a successful empty overflow probe', async () => {
    let count = 0;
    const data = await readCompleteUploaderCatalog(async (_cursor: number | undefined, limit: number) => {
      const items = count === 10000 ? [] : Array(limit).fill('entry');
      count += items.length;
      return { items, cursor: count };
    });
    expect(data).toHaveLength(10000);
  });
  it('never overwrites manual selection or clearing, including late defaults and retries', () => {
    const defaults = ['latest'];
    const manual = ['chosen'];
    const cleared: string[] = [];
    expect(applyLatestUploaderDefault(manual, defaults, true, true)).toBe(manual);
    expect(applyLatestUploaderDefault(cleared, defaults, true, true)).toBe(cleared);
    expect(applyLatestUploaderDefault(cleared, defaults, false, false)).toBe(cleared);
    expect(applyLatestUploaderDefault(manual, defaults, true, false)).toBe(manual);
    expect(applyLatestUploaderDefault([], defaults, true, false)).toBe(defaults);
    expect(applyLatestUploaderDefault([], [], true, false)).toEqual([]);
  });
});

describe('cancelled catalog reads and admitted upload preservation', () => {
  it('does not begin a fallback after the component stops observing', async () => {
    let current = true;
    const fallback = jest.fn(async () => ['unexpected']);
    expect(
      await loadUploaderCatalog(
        async () => {
          current = false;
          throw new Error('bundle unavailable');
        },
        fallback,
        () => current
      )
    ).toEqual({ ok: false });
    expect(fallback).not.toHaveBeenCalled();
  });
  it('does not fetch a second category page after cancellation', async () => {
    let current = true;
    const read = jest.fn(async () => {
      current = false;
      return { items: Array(250).fill('entry'), cursor: 250 };
    });
    await expect(readCompleteUploaderCatalog(read, () => current)).rejects.toThrow('cancelled');
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('blocks unresolved defaults only before admission, preserving an existing receipt recovery path', () => {
    expect(catalogBlocksNewAdmission(false, true)).toBe(true);
    expect(catalogBlocksNewAdmission(false, false)).toBe(false);
    expect(catalogBlocksNewAdmission(true, true)).toBe(false);
    expect(catalogBlocksNewAdmission(true, false)).toBe(false);
  });
});
