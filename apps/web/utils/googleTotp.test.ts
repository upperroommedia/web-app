import { generateGoogleTotp } from './googleTotp';

// RFC 6238's SHA-1 key and test vectors, reduced to the authenticator's six digits.
const key = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
describe('Google authenticator compatibility', () => {
  test.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('matches RFC vector at %i seconds, retaining leading zeros', (seconds, code) => {
    expect(generateGoogleTotp(key, seconds * 1000).code).toBe(code);
  });
  it('reports expiry at the next 30-second boundary', () => {
    expect(generateGoogleTotp(key, 59_500)).toEqual({ code: '287082', serverTimeMs: 59_500, expiresAtMs: 60_000 });
    expect(generateGoogleTotp(key, 60_000).code).not.toBe('287082');
  });
  it('accepts whitespace and lowercase but rejects an invalid secret', () => {
    expect(generateGoogleTotp(key.toLowerCase() + '==', 59_000).code).toBe('287082');
    expect(() => generateGoogleTotp('not-a-secret')).toThrow();
  });
});
