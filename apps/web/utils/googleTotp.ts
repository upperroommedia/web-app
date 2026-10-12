import { createHmac } from 'node:crypto';

// Matches subsplash-auth's otplib authenticator defaults (Base32, SHA-1, 30s, six digits).
export const generateGoogleTotp = (secret: string, nowMs = Date.now()) => {
  const normalized = secret.replace(/\s/g, '').replace(/=+$/, '').toUpperCase();
  if (!/^[A-Z2-7]{16,}$/.test(normalized)) throw new Error('Google authenticator is not configured correctly.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000)));
  const hash = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = hash[hash.length - 1] & 15;
  const code = ((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return { code, expiresAtMs: (Math.floor(nowMs / 30_000) + 1) * 30_000, serverTimeMs: nowMs };
};
