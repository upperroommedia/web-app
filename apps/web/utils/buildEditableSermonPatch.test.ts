import { createEmptySermon } from '../types/Sermon';
import { buildEditableSermonPatch } from './buildEditableSermonPatch';

describe('buildEditableSermonPatch', () => {
  it('omits trimDurationSeconds when a legacy sermon does not have saved trim settings', () => {
    const sermon = createEmptySermon('user-1');
    delete sermon.trimDurationSeconds;

    const patch = buildEditableSermonPatch(sermon);

    expect(Object.prototype.hasOwnProperty.call(patch, 'trimDurationSeconds')).toBe(false);
  });

  it('includes trimDurationSeconds when the sermon has saved trim settings', () => {
    const sermon = createEmptySermon('user-1');
    sermon.trimDurationSeconds = 900;

    const patch = buildEditableSermonPatch(sermon);

    expect(patch.trimDurationSeconds).toBe(900);
  });
});
