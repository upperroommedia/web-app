import { normalizeHttpContentType } from '../../helpers/httpResponseHeaders';

describe('normalizeHttpContentType', () => {
  it('returns a trimmed string content type', () => {
    expect(normalizeHttpContentType(' image/jpeg ')).toBe('image/jpeg');
  });

  it.each([undefined, null, '', '   ', 123, true, ['image/jpeg']])(
    'ignores an unusable content-type header: %p',
    (headerValue) => {
      expect(normalizeHttpContentType(headerValue)).toBeUndefined();
    }
  );
});
