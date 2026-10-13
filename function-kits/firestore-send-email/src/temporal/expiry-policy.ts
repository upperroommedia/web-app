import { Timestamp } from 'firebase-admin/firestore';
export interface EmailExpiryPolicy {
  type: string;
  value: number;
}
export function expiryForPolicy(startTime: Timestamp, policy: EmailExpiryPolicy): Timestamp | undefined {
  if (!policy || policy.type === 'never') return undefined;
  const now = startTime.toDate();
  const value = policy.value;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('EMAIL_EXPIRY_POLICY_INVALID');
  switch (policy.type) {
    case 'hour':
      now.setUTCHours(now.getUTCHours() + value);
      break;
    case 'day':
      now.setUTCDate(now.getUTCDate() + value);
      break;
    case 'week':
      now.setUTCDate(now.getUTCDate() + value * 7);
      break;
    case 'month':
      now.setUTCMonth(now.getUTCMonth() + value);
      break;
    case 'year':
      now.setUTCFullYear(now.getUTCFullYear() + value);
      break;
    default:
      throw new Error('EMAIL_EXPIRY_POLICY_INVALID');
  }
  return Timestamp.fromDate(now);
}
