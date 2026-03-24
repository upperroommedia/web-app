import React from 'react';
import useAuth from '../context/user/UserContext';
import { User, UserRoleType } from '../types/User';

type UserRoleGuardProps = {
  allowedUserRoles: Array<UserRoleType>;
  renderItems: React.ReactNode | ((user: User) => React.ReactNode);
};

export default function UserRoleGuard({ allowedUserRoles, renderItems }: UserRoleGuardProps) {
  const { user } = useAuth();
  if (!user || !user.role) {
    return null;
  }
  if (!allowedUserRoles.includes(user?.role)) {
    return null;
  }
  return typeof renderItems === 'function' ? <>{renderItems(user)}</> : <>{renderItems}</>;
}
