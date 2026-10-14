import assert from 'node:assert/strict';
import {
  authenticateNativeMediaCaller,
  assertBoundNativeMediaTask,
  nativeCallerConfiguration,
} from '../src/legacyMediaIngress';
import {
  computeProcessAudioRequestVersion,
  type StoredProcessAudioRequestState,
} from '../../../packages/contracts/processAudioQueue';

async function main() {
  const config = {
    audiences: ['https://owned.example/process-audio'],
    serviceAccountEmails: ['queue@owned.iam.gserviceaccount.com'],
  };
  const claims = {
    iss: 'https://accounts.google.com',
    sub: '123',
    email_verified: true,
    email: config.serviceAccountEmails[0],
  };
  let verified = 0;
  const verify = async (token: string, audiences: string[]) => {
    verified++;
    assert.equal(token, 'signed');
    assert.deepEqual(audiences, config.audiences);
    return claims;
  };
  await authenticateNativeMediaCaller('Bearer signed', config, verify);
  assert.equal(verified, 1);
  for (const bad of [undefined, '', 'Basic signed', 'Bearer forged extra'])
    await assert.rejects(authenticateNativeMediaCaller(bad, config, verify));
  assert.equal(verified, 1, 'Unauthenticated inputs never reach verification or queue processing');
  for (const bad of [
    { ...claims, email: 'user@gmail.com' },
    { ...claims, email: 'other@owned.iam.gserviceaccount.com' },
    { ...claims, email_verified: false },
    { ...claims, iss: 'https://attacker.example' },
    { ...claims, sub: '' },
  ])
    await assert.rejects(authenticateNativeMediaCaller('Bearer signed', config, async () => bad));
  await assert.rejects(
    authenticateNativeMediaCaller(
      'Bearer signed',
      { audiences: [], serviceAccountEmails: config.serviceAccountEmails },
      verify
    )
  );
  await assert.rejects(
    authenticateNativeMediaCaller(
      'Bearer signed',
      { audiences: config.audiences, serviceAccountEmails: ['user@gmail.com'] },
      verify
    )
  );
  await assert.rejects(
    authenticateNativeMediaCaller('Bearer signed', config, async () => {
      throw new Error('Bad signature or wrong audience');
    })
  );
  assert.throws(() => nativeCallerConfiguration({ PROCESS_AUDIO_OIDC_AUDIENCES: '"one"' }));
  const payload = {
    id: 'owned-sermon',
    storageFilePath: 'sermons/owned-sermon',
    startTime: 0,
    duration: 20,
    deleteOriginal: false,
  };
  const state = {
    sermonId: payload.id,
    queuedTaskId: 'pa-owned',
    currentRequestVersion: computeProcessAudioRequestVersion(payload),
    currentPayload: payload,
  } as StoredProcessAudioRequestState;
  assertBoundNativeMediaTask(payload, 'pa-owned', state);
  for (const invalid of [
    null,
    { ...state, queuedTaskId: 'other' },
    { ...state, currentRequestVersion: 'other' },
    { ...state, currentPayload: { ...payload, duration: 25 } },
    { ...state, sermonId: 'other' },
  ])
    assert.throws(() => assertBoundNativeMediaTask(payload, 'pa-owned', invalid));
  assert.throws(() => assertBoundNativeMediaTask(payload, null, state));
  console.log(
    'Native legacy ingress: verified caller, audience, signature failure, exact admission binding: 21 cases passed.'
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
