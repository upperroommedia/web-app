import type firebaseAdmin from '@upperroom/shared/firebase/firebaseAdmin';
import { DirectoryUser, UserRoleType } from '@upperroom/shared/types/User';

export const toDirectoryUser = (user: firebaseAdmin.auth.UserRecord): DirectoryUser => ({
  uid: user.uid,
  email: user.email ?? null,
  photoURL: user.photoURL ?? null,
  displayName: user.displayName ?? null,
  role: user.customClaims?.role as UserRoleType | undefined,
  firstName: '',
  lastName: '',
  emailVerified: user.emailVerified,
  isAnonymous: false,
  metadata: {
    creationTime: user.metadata.creationTime,
    lastSignInTime: user.metadata.lastSignInTime,
    lastRefreshTime: user.metadata.lastRefreshTime,
  },
  providerData: user.providerData.map((provider) => ({
    uid: provider.uid,
    displayName: provider.displayName,
    email: provider.email,
    photoURL: provider.photoURL,
    providerId: provider.providerId,
    phoneNumber: provider.phoneNumber,
  })),
  refreshToken: '',
  tenantId: user.tenantId ?? null,
  phoneNumber: user.phoneNumber ?? null,
  providerId: '',
});
