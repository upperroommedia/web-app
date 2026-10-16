import { Timestamp, type DocumentSnapshot } from 'firebase-admin/firestore';
import { readSearchTask, readConfirmedSearchSave, searchDigest, sourceVersion, singleSearchTaskId } from './checkpoint';
const target = searchDigest(['project', 'app', 'index', 'instance', 'sermons/a']);
const receipt = {
  schemaVersion: 1,
  targetDigest: target,
  action: 'addObject',
  objectId: 'a',
  taskID: 713,
  sourceVersion: '1:1000000',
  recordDigest: searchDigest({ title: 'Approved' }),
  requestedByJobId: 'job-one',
};

test('task facts require exact reviewed target and payload/source identity', () => {
  expect(readSearchTask(receipt, target)).toEqual(receipt);
  expect(readSearchTask(null, target)).toBeUndefined();
  for (const changed of [
    [],
    { ...receipt, taskID: NaN },
    { ...receipt, taskID: -1 },
    { ...receipt, targetDigest: '0'.repeat(64) },
    { ...receipt, recordDigest: undefined },
    { ...receipt, sourceVersion: 'absent' },
    { ...receipt, requestedByJobId: '' },
    { ...receipt, arbitraryEndpoint: 'https://foreign.example' },
  ])
    expect(() => readSearchTask(changed, target)).toThrow('Search provider operation could not be confirmed');
});
test('delete receipt cannot carry an invented record digest', () => {
  const rest = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'recordDigest'));
  const deleted = { ...rest, action: 'deleteObject', sourceVersion: 'absent' };
  expect(readSearchTask(deleted, target)).toEqual(deleted);
  expect(() => readSearchTask({ ...deleted, recordDigest: receipt.recordDigest }, target)).toThrow();
});
test('confirmed source cache is bound to its exact job, schema, payload and target', () => {
  const confirmed = {
    schemaVersion: 1,
    confirmedForJobId: 'job-one',
    targetDigest: target,
    objectId: 'a',
    sourceVersion: '1:1000000',
    recordDigest: receipt.recordDigest,
  };
  expect(readConfirmedSearchSave(confirmed, target)).toEqual(confirmed);
  expect(readConfirmedSearchSave(confirmed, '0'.repeat(64))).toBeUndefined();
  expect(() => readConfirmedSearchSave({ ...confirmed, confirmedForJobId: undefined }, target)).toThrow();
  expect(() => readConfirmedSearchSave({ ...confirmed, recordDigest: 'unknown' }, target)).toThrow();
});
test('source version uses actual nanosecond timestamp authority, never current local time', () => {
  expect(sourceVersion({ exists: true, updateTime: new Timestamp(713, 123456789) } as DocumentSnapshot)).toBe(
    '713:123456789'
  );
  expect(sourceVersion({ exists: false } as DocumentSnapshot)).toBe('absent');
  expect(() => sourceVersion({ exists: true } as DocumentSnapshot)).toThrow();
});
test('one-object batch requires exactly one safe task receipt', () => {
  expect(singleSearchTaskId([{ taskID: 713 }])).toBe(713);
  for (const receipts of [
    [],
    [{ taskID: 1 }, { taskID: 2 }],
    [{ taskID: NaN }],
    [{ taskID: Number.MAX_SAFE_INTEGER + 1 }],
  ])
    expect(() => singleSearchTaskId(receipts)).toThrow();
});

test('receipt CAS digests ignore Firestore object key order but preserve payload values and array order', () => {
  const reordered = Object.fromEntries(Object.entries(receipt).reverse());
  expect(searchDigest(receipt)).toBe(searchDigest(reordered));
  expect(searchDigest({ nested: { a: 1, b: 2 }, sequence: ['first', 'second'] })).toBe(
    searchDigest({ sequence: ['first', 'second'], nested: { b: 2, a: 1 } })
  );
  expect(searchDigest({ sequence: ['first', 'second'] })).not.toBe(searchDigest({ sequence: ['second', 'first'] }));
  expect(searchDigest(receipt)).not.toBe(searchDigest({ ...receipt, taskID: 999 }));
});
