import { Timestamp } from 'firebase-admin/firestore';
import config from '../config';
import { expiryForPolicy, EmailExpiryPolicy } from './expiry-policy';
export function getEmailExpiryPolicy(): EmailExpiryPolicy {
  return { type: config.TTLExpireType || 'never', value: config.TTLExpireValue ?? 1 };
}
export function getEmailExpireAt(startTime: Timestamp): Timestamp {
  const expiry = expiryForPolicy(startTime, getEmailExpiryPolicy());
  if (!expiry) throw new Error('EMAIL_EXPIRY_NOT_CONFIGURED');
  return expiry;
}
