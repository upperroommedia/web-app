import {
  getAdminBaseUrlEnv,
  getRoleRequestRecipientsEnv,
  getRuntimeAlertRecipientsEnv,
} from '../env';

export const getRoleRequestRecipients = (): string[] => getRoleRequestRecipientsEnv();

export const getRuntimeAlertRecipients = (): string[] => getRuntimeAlertRecipientsEnv();

export const getAdminBaseUrl = (): string => getAdminBaseUrlEnv();
