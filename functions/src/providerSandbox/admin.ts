import { onCall, HttpsError } from 'firebase-functions/v2/https';
import firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { canUserRoleUpload, isUserRoleAdmin } from '@upperroom/shared/types/User';
import type {
  ProviderSandboxStatus,
  ProviderSandboxJobInspection,
  ProviderSandboxResourceSummary,
} from '@upperroom/contracts/providerSandbox';
import { getProviderExecutionProfile, assertSandboxCatalogReady, sandboxProfileDocumentPath } from './profile';

/** Safe status only: no credentials, resource bodies or provider URLs leave the server. */
export const getProviderSandboxStatus = onCall<Record<string, never>>(
  async (request): Promise<ProviderSandboxStatus> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to check publishing mode.');
    if (!canUserRoleUpload(request.auth.token.role))
      throw new HttpsError('permission-denied', 'Upload access is required.');
    let profile;
    try {
      profile = getProviderExecutionProfile();
    } catch {
      return {
        mode: 'blocked',
        ready: false,
        catalogReady: false,
        scenarioSelectionAllowed: false,
        reason: 'configuration-unavailable',
      };
    }
    if (profile.mode === 'live')
      return { mode: 'live', ready: true, catalogReady: false, scenarioSelectionAllowed: false };
    try {
      const marker = await firebaseAdmin.firestore().doc(sandboxProfileDocumentPath(profile)).get();
      assertSandboxCatalogReady(profile, marker.data());
      return {
        mode: 'sandbox',
        ready: true,
        catalogReady: true,
        profileId: profile.profileId,
        version: 1,
        scenarioSelectionAllowed: isUserRoleAdmin(request.auth.token.role),
      };
    } catch {
      return {
        mode: 'blocked',
        ready: false,
        catalogReady: false,
        scenarioSelectionAllowed: false,
        reason: 'catalog-not-ready',
      };
    }
  }
);

/** Read-only recovery evidence. This endpoint never acknowledges or resolves a publication. */
export const inspectProviderSandboxJob = onCall<{ jobId: string }>(
  async (request): Promise<ProviderSandboxJobInspection> => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to inspect a simulated task.');
    const actor = await firebaseAdmin.auth().getUser(request.auth.uid);
    if (actor.disabled || !isUserRoleAdmin(actor.customClaims?.role))
      throw new HttpsError('permission-denied', 'Only current administrators can inspect simulated tasks.');
    const input = request.data;
    if (
      !input ||
      Object.keys(input).some((key) => key !== 'jobId') ||
      typeof input.jobId !== 'string' ||
      !input.jobId ||
      input.jobId.trim() !== input.jobId ||
      input.jobId.length > 200 ||
      /[\/\u0000-\u001f]/.test(input.jobId)
    )
      throw new HttpsError('invalid-argument', 'A valid task ID is required.');
    try {
      const profile = getProviderExecutionProfile();
      if (profile.mode !== 'sandbox') throw new Error('Not sandbox');
      const marker = await firebaseAdmin.firestore().doc(sandboxProfileDocumentPath(profile)).get();
      assertSandboxCatalogReady(profile, marker.data());
      // The engine independently binds immutable intent/public job pins and their generation.
      const { inspectSandboxJob } = await import('./service');
      const snapshot = await inspectSandboxJob(profile, input.jobId);
      // Explicit public projection remains body-free even if engine metadata grows later.
      const resource = (value: ProviderSandboxResourceSummary): ProviderSandboxResourceSummary => ({
        provider: value.provider,
        family: value.family,
        id: value.id,
        deleted: value.deleted,
        ...(value.title && !/(?:https?|gs):\/\/|www\./i.test(value.title) ? { title: value.title } : {}),
        ...(value.readyAtMillis === undefined ? {} : { readyAtMillis: value.readyAtMillis }),
      });
      return {
        jobId: snapshot.jobId,
        profileId: snapshot.profileId,
        providerExecution: {
          mode: 'sandbox',
          profileId: snapshot.providerExecution.profileId,
          version: 1,
          scenario: snapshot.providerExecution.scenario,
        },
        observedAtMillis: Date.now(),
        requests: snapshot.requests.map((row) => ({
          provider: row.provider,
          method: row.method,
          atMillis: row.atMillis,
          outcome: row.outcome,
          fault: row.fault,
          resourceRefs: row.resourceRefs.map(resource),
        })),
        resources: snapshot.resources.map(resource),
        truncated: { requests: snapshot.truncated.requests, resources: snapshot.truncated.resources },
      };
    } catch {
      throw new HttpsError(
        'failed-precondition',
        'This simulated task could not be inspected. Verify the staging profile, catalog and task identity.'
      );
    }
  }
);
