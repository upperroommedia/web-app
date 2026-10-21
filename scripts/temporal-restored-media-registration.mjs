/** Fixed original recovery-plan lookup for retained registration. This is only
 * an input to the full historical collector; it never grants authority. */
export async function readRestoredMediaRecoveryPlan({ firestore, recoveryOperationId, plan }) {
  const fail = () => {
    throw new Error('RESTORED_MEDIA_REGISTRATION_UNCONFIRMED');
  };
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(recoveryOperationId)) fail();
  const at = Date.now(),
    mono = performance.now();
  const fresh = () => {
    if (Date.now() < at || Date.now() - at >= 5000 || performance.now() < mono || performance.now() - mono >= 5000)
      fail();
  };
  let timer;
  try {
    const snapshot = await Promise.race([
      Promise.resolve().then(() => {
        fresh();
        return firestore.doc(`_control/temporalCloudMediaRecovery-${recoveryOperationId}`).get();
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('RESTORED_MEDIA_REGISTRATION_UNCONFIRMED')), 5000);
      }),
    ]);
    fresh();
    const p = snapshot.get('identityState.plan');
    if (
      !snapshot.exists ||
      !p ||
      p.operationId !== recoveryOperationId ||
      p.buildId !== plan.buildId ||
      p.image !== plan.image
    )
      fail();
    return p;
  } catch {
    return fail();
  } finally {
    clearTimeout(timer);
  }
}
