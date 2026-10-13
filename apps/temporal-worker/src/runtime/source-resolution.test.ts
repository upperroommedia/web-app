test('workspace builds cannot shadow source Firebase or workflow entrypoints', () => {
  expect(require.resolve('../../../../packages/shared/firebase/firebaseAdmin')).toMatch(/firebaseAdmin\.ts$/);
  expect(require.resolve('../workflows/publishing')).toMatch(/publishing\/index\.ts$/);
});
