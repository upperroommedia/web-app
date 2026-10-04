import type { NextApiRequest, NextApiResponse } from 'next';
import firebaseAdmin from '../../../firebase/firebaseAdmin';
import { getFirebaseProjectId } from '../../../shared/firebaseProjectConfig';
import { generateGoogleTotp } from '../../../utils/googleTotp';

export default async function youtubeAuth(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!bearer) return res.status(401).json({ error: 'Sign in to continue.' });
  let adminUid: string;
  try {
    const claims = await firebaseAdmin.auth().verifyIdToken(bearer, true);
    adminUid = claims.uid;
    const currentUser = await firebaseAdmin.auth().getUser(claims.uid);
    if (currentUser.disabled || currentUser.customClaims?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
  } catch {
    return res.status(401).json({ error: 'Your session expired. Sign in again.' });
  }
  const workerOrigin =
    getFirebaseProjectId() === 'urm-app-staging'
      ? 'https://yt-worker-staging.upperroommedia.org'
      : 'https://yt-worker.upperroommedia.org';
  const desktopOrigin = process.env.YOUTUBE_AUTH_WORKER_ORIGIN || workerOrigin;
  if (req.method === 'GET') {
    return res.status(200).json({
      sessionUrl: `${desktopOrigin}/youtube-auth/session`,
      codeConfigured: Boolean(process.env.TWO_FACTOR_GOOGLE_LOGIN),
      credentialsConfigured: Boolean(process.env.YOUTUBE_LOGIN_EMAIL && process.env.YOUTUBE_LOGIN_PASSWORD),
    });
  }
  if (req.body?.action === 'credentials') {
    const email = process.env.YOUTUBE_LOGIN_EMAIL;
    const password = process.env.YOUTUBE_LOGIN_PASSWORD;
    if (!email || !password) {
      return res
        .status(503)
        .json({ error: 'Google login details have not been configured. Contact the system administrator.' });
    }
    // Record access without recording credentials or the request token.
    // eslint-disable-next-line no-console
    console.info('Admin accessed Google login details', { uid: adminUid });
    return res.status(200).json({ email, password });
  }
  if (req.body?.action === 'recover') {
    try {
      const response = await fetch(`${desktopOrigin}/youtube-auth/recover`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        return res
          .status(response.status === 401 || response.status === 403 ? response.status : 502)
          .json({ error: 'Could not start the YouTube recovery check. Please try again.' });
      return res.status(202).json({ checking: true });
    } catch {
      return res.status(502).json({ error: 'Could not start the YouTube recovery check. Please try again.' });
    }
  }
  if (req.body?.action === 'status') {
    try {
      const response = await fetch(`${desktopOrigin}/readyz`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok && response.status !== 503) throw new Error('Worker unavailable');
      const readiness = await response.json();
      return res.status(200).json({ authenticated: readiness.capabilities?.authenticated ?? null });
    } catch {
      return res.status(502).json({ error: 'Could not check YouTube. Please try again.' });
    }
  }
  if (req.body?.action !== 'code') return res.status(400).json({ error: 'Unknown action.' });
  if (!process.env.TWO_FACTOR_GOOGLE_LOGIN) {
    return res.status(503).json({ error: 'The Google authenticator secret has not been configured.' });
  }
  try {
    const result = generateGoogleTotp(process.env.TWO_FACTOR_GOOGLE_LOGIN);
    // Audit the administrator only; never log the generated code or secret.
    // eslint-disable-next-line no-console
    console.info('Admin generated Google login code', { uid: adminUid });
    return res.status(200).json(result);
  } catch {
    return res.status(503).json({ error: 'Google code generation is unavailable. Contact the system administrator.' });
  }
}
