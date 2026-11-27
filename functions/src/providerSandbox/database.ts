import type { Firestore } from 'firebase-admin/firestore';

/** Require the initialized staging default database, independent of caller input. */
export function isStagingSandboxDatabase(db: Firestore, projectId: string): boolean {
  return projectId === 'urm-app-staging' && 'projectId' in db && db.projectId === projectId &&
    db.databaseId === '(default)';
}
