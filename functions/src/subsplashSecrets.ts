import { defineSecret } from 'firebase-functions/params';

export const subsplashEmailSecret = defineSecret('SUBSPLASH_EMAIL');
export const subsplashPasswordSecret = defineSecret('SUBSPLASH_PASSWORD');

export const subsplashSecrets = [subsplashEmailSecret, subsplashPasswordSecret];
