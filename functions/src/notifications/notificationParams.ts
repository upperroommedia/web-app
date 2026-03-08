import { getEnv } from '../env';

export const getRoleRequestRecipients = (): string[] => getEnv().roleRequestRecipients;

export const getRuntimeAlertRecipients = (): string[] => getEnv().runtimeAlertRecipients;

export const getAdminBaseUrl = (): string => getEnv().adminBaseUrl;

