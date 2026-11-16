import { getSubsplashTagValidationError } from '@upperroom/shared/shared/subsplashTagValidation';

describe('Subsplash tag validation shared by uploader and publish preflight', () => {
  it('accepts missing tags for partial edits and explicit empty tags for clearing', () => {
    expect(getSubsplashTagValidationError({})).toBeNull();
    expect(getSubsplashTagValidationError({ topics: [], speakers: [] })).toBeNull();
  });

  it('preserves the ten-topic boundary and rejects an older sermon with eleven topics', () => {
    const topics = Array.from({ length: 10 }, (_, index) => `Topic ${index}`);
    expect(getSubsplashTagValidationError({ topics })).toBeNull();
    expect(getSubsplashTagValidationError({ topics: [...topics, 'Another topic'] })).toMatch('at most 10 topics');
  });

  it.each([null, 'topic', [null], [1], ['   ']])('rejects malformed topics: %j', (topics) => {
    expect(getSubsplashTagValidationError({ topics })).toMatch('non-empty names');
  });

  it('accepts three speakers and rejects four', () => {
    const speakers = Array.from({ length: 3 }, (_, index) => ({ name: `Speaker ${index}` }));
    expect(getSubsplashTagValidationError({ speakers })).toBeNull();
    expect(getSubsplashTagValidationError({ speakers: [...speakers, { name: 'Another speaker' }] })).toMatch(
      'at most 3 speakers'
    );
  });
});
