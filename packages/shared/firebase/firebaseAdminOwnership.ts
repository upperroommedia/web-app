import type { App } from 'firebase-admin/app';

export interface SharedFirebaseAppOwnership {
  readonly app: App;
  isRegistered: () => boolean;
  terminateFirestore: () => Promise<void>;
  deleteApp: () => Promise<void>;
}
// Side-effect-free registry. Bound teardown functions come from the creator's
// exact Admin SDK instance, even if a process contains another SDK installation.
let owned: SharedFirebaseAppOwnership | undefined;
export function recordSharedFirebaseAppCreation(ownership: SharedFirebaseAppOwnership): void {
  owned = ownership;
}
export function getSharedFirebaseAppOwnership(): SharedFirebaseAppOwnership | undefined {
  return owned;
}
