import { getAdminBaseUrlEnv, getAdminRequestRecipientsEnv, getRuntimeAlertRecipientsEnv } from '../env';

export const getAdminRequestRecipients = (): string[] => getAdminRequestRecipientsEnv();

export const getRuntimeAlertRecipients = (): string[] => getRuntimeAlertRecipientsEnv();

export const getAdminBaseUrl = (): string => getAdminBaseUrlEnv();
