/**
 * Dev-only authentication helpers.
 * These functions are only meant for development with the Firebase emulator.
 */

export const DEV_ADMIN_EMAIL = 'dev-admin@test.local';
export const DEV_ADMIN_PASSWORD = 'devadmin123';

export const isDevelopment = process.env.NODE_ENV === 'development';
