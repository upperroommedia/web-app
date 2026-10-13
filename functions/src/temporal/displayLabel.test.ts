import { entityLabel } from './displayLabel';
describe('canonical public Activity labels', () => {
  it('uses a bounded plain display hint', () => {
    expect(entityLabel('  Sermon title  ')).toEqual({ label: 'Sermon title' });
    expect(entityLabel('a'.repeat(500)).label).toHaveLength(200);
  });
  it('omits unsafe controls without rejecting legitimate admission', () => {
    expect(entityLabel('title\nsecond line')).toEqual({});
    expect(entityLabel('hidden\u202ename')).toEqual({});
  });
  it('omits authorization-shaped values and absent titles', () => {
    expect(entityLabel('Bearer confidential')).toEqual({});
    expect(entityLabel('https://example.test?token=private')).toEqual({});
    expect(entityLabel(undefined)).toEqual({});
  });
});
