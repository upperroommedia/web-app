import { AccountDomainError, validateAccountIntent } from './types';

describe('private account intent admission', () => {
  test.each([
    null,
    {},
    { action: 'role-accept', requestId: '../other' },
    { action: 'invite-claim', inviteId: 'id', claimantUid: '' },
  ])('rejects malformed references: %p', (value) => {
    expect(() => validateAccountIntent(value)).toThrow(AccountDomainError);
  });
  it('preserves private intent without exposing it as a workflow plan', () => {
    expect(
      validateAccountIntent({
        action: 'invite-email',
        inviteId: 'invite',
        inviteUrl: 'https://example.test/invite?token=private',
      })
    ).toEqual({ action: 'invite-email', inviteId: 'invite', inviteUrl: 'https://example.test/invite?token=private' });
  });
  it('uses a fixed domain error code rather than input in errors', () => {
    expect(() => validateAccountIntent({ action: 'secret-input' })).toThrow('INVALID_ACCOUNT_INTENT');
  });
});
