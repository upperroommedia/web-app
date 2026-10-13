import { normalizeImageAdmission } from './admission';

const actorUid = 'editor';
const requestId = 'request-1';
const sourcePath = `durable-image-sources/${actorUid}/${requestId}/source`;
const valid = {
  generation: '42',
  contentType: 'image/png',
  size: '128',
  metadata: { ownerUID: actorUid, durableRequestId: requestId },
};
function dependencies(metadata = valid) {
  const getMetadata = jest.fn(async () => [metadata]);
  const file = jest.fn(() => ({ getMetadata }));
  const storage = { bucket: jest.fn(() => ({ file })) } as unknown as Parameters<
    typeof normalizeImageAdmission
  >[0]['storage'];
  const firestore = {} as Parameters<typeof normalizeImageAdmission>[0]['firestore'];
  return { storage, firestore, file, getMetadata };
}
function input(deps = dependencies()): Parameters<typeof normalizeImageAdmission>[0] {
  return {
    ...deps,
    kind: 'image.ingest',
    entityId: requestId,
    requestId,
    actorUid,
    imagesBucket: 'image-bucket',
    payload: {
      sourcePath,
      sourceGeneration: '42',
      contentType: 'image/png',
      type: 'wide',
      name: 'Image',
      remoteId: 'attacker-supplied',
    },
  };
}
test('image admission pins generation, derives identity, and ignores arbitrary browser provider IDs', async () => {
  const deps = dependencies();
  const first = await normalizeImageAdmission(input(deps));
  const second = await normalizeImageAdmission(input(deps));
  expect(first.imageId).toBe(second.imageId);
  expect(first.remoteId).toBeUndefined();
  expect(first.source.generation).toBe('42');
  expect(deps.file).toHaveBeenCalledWith(sourcePath, { generation: '42' });
});
test.each([
  { ...valid, metadata: { ownerUID: 'another-user', durableRequestId: requestId } },
  { ...valid, generation: '43' },
  { ...valid, contentType: 'text/html' },
  { ...valid, size: String(26 * 1024 * 1024) },
])('rejects foreign, changed, invalid, or oversized source', async (metadata) => {
  await expect(normalizeImageAdmission(input(dependencies(metadata)))).rejects.toThrow('ownership or content');
});
test('rejects shared mutable source paths before any provider or storage effect', async () => {
  const deps = dependencies();
  const request = input(deps);
  request.payload.sourcePath = 'speaker-images/reused.png';
  await expect(normalizeImageAdmission(request)).rejects.toThrow('Invalid image upload source');
  expect(deps.getMetadata).not.toHaveBeenCalled();
});
