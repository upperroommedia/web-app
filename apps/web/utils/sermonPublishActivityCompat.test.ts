import { createEmptySermon } from '../types/Sermon';

describe('sermon publish activity compatibility', () => {
  it('supports missing publishActivity on legacy sermon documents', () => {
    const sermon = createEmptySermon();

    expect(sermon.publishActivity).toBeUndefined();
  });
});
