import express from 'express';
import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { rateLimit } from 'express-rate-limit';

const PREFIX = '/youtube-auth';
const COOKIE = '__Secure-urm-youtube-desktop';
const SESSION_MS = 15 * 60_000;
type Session = { uid: string; expiresAt: number };
export type DesktopAuth = {
  verifyIdToken(token: string, checkRevoked: boolean): Promise<{ uid: string }>;
  getUser(
    uid: string
  ): Promise<{ disabled: boolean; customClaims?: Record<string, unknown>; tokensValidAfterTime?: string }>;
};

export function installYouTubeAdminDesktop(
  app: express.Express,
  auth: DesktopAuth,
  options: {
    adminOrigin: string;
    desktopOrigin: string;
    socketPath: string;
    audit: (event: string, uid: string) => void;
  }
) {
  const sessions = new Map<string, Session>();
  const adminOrigin = new URL(options.adminOrigin).origin;
  const desktopOrigin = new URL(options.desktopOrigin).origin;
  const cookieValue = (req: IncomingMessage) =>
    req.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
  const authorize = async (req: IncomingMessage) => {
    const id = cookieValue(req);
    const session = id ? sessions.get(id) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (id) sessions.delete(id);
      return null;
    }
    try {
      const user = await auth.getUser(session.uid);
      const revokedAt = user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : 0;
      if (user.disabled || user.customClaims?.role !== 'admin' || revokedAt > session.expiresAt - SESSION_MS) {
        sessions.delete(id!);
        return null;
      }
      return session;
    } catch {
      return null;
    }
  };
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${adminOrigin}`);
    next();
  });
  router.post(
    '/session',
    rateLimit({ windowMs: 60_000, limit: 20 }),
    express.urlencoded({ extended: false, limit: '8kb' }),
    async (req, res) => {
      if (req.headers.origin !== adminOrigin) {
        res.status(403).send('Open the desktop from the admin panel.');
        return;
      }
      if (typeof req.body?.idToken !== 'string') {
        res.status(401).send('Sign in again.');
        return;
      }
      try {
        const claims = await auth.verifyIdToken(req.body.idToken, true);
        const user = await auth.getUser(claims.uid);
        if (user.disabled || user.customClaims?.role !== 'admin') {
          res.status(403).send('Admin access required.');
          return;
        }
        for (const [id, session] of sessions) {
          if (session.expiresAt <= Date.now() || session.uid === claims.uid) sessions.delete(id);
        }
        if (sessions.size >= 100) {
          res.status(503).send('Too many active desktop sessions. Try again later.');
          return;
        }
        const id = randomBytes(32).toString('hex');
        sessions.set(id, { uid: claims.uid, expiresAt: Date.now() + SESSION_MS });
        res.setHeader(
          'Set-Cookie',
          `${COOKIE}=${id}; Path=${PREFIX}/; Max-Age=900; HttpOnly; Secure; SameSite=None; Partitioned`
        );
        options.audit('YouTube desktop session opened', claims.uid);
        res.redirect(303, `${PREFIX}/vnc.html?autoconnect=true&resize=scale&path=youtube-auth/websockify`);
      } catch {
        res.status(401).send('Your session expired. Return to the admin panel and reconnect.');
      }
    }
  );
  router.use(async (req, res) => {
    if (!(await authorize(req))) {
      res.status(401).send('Desktop access expired. Return to the admin panel and reconnect.');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).end();
      return;
    }
    const upstream = httpRequest({ socketPath: options.socketPath, path: req.url, method: req.method }, (response) => {
      res.status(response.statusCode || 502);
      for (const [name, value] of Object.entries(response.headers)) {
        if (value && !['set-cookie', 'content-security-policy', 'x-frame-options', 'cache-control'].includes(name))
          res.setHeader(name, value);
      }
      response.pipe(res);
    });
    upstream.setTimeout(10_000, () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent)
        res.status(502).send('The remote browser is unavailable. Please contact the system administrator.');
      else res.destroy();
    });
    req.on('aborted', () => upstream.destroy());
    upstream.end();
  });
  app.use(PREFIX, router);

  return (server: Server) =>
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      void (async () => {
        if (req.url !== `${PREFIX}/websockify` || req.headers.origin !== desktopOrigin) {
          socket.destroy();
          return;
        }
        const session = await authorize(req);
        if (!session) {
          socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          return;
        }
        const upstream = httpRequest({
          socketPath: options.socketPath,
          path: '/websockify',
          headers: {
            host: 'localhost',
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-key': req.headers['sec-websocket-key'] || '',
            'sec-websocket-version': req.headers['sec-websocket-version'] || '13',
            ...(req.headers['sec-websocket-protocol']
              ? { 'sec-websocket-protocol': req.headers['sec-websocket-protocol'] }
              : {}),
          },
        });
        upstream.on('error', () => socket.destroy());
        upstream.on('response', () => {
          upstream.destroy();
          socket.destroy();
        });
        upstream.setTimeout(10_000, () => upstream.destroy());
        upstream.on('upgrade', (response, remote, remoteHead) => {
          remote.setTimeout(0);
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\r\n')}\r\n\r\n`
          );
          if (remoteHead.length) socket.write(remoteHead);
          if (head.length) remote.write(head);
          socket.pipe(remote).pipe(socket);
          const expiry = setTimeout(() => socket.destroy(), Math.max(0, session.expiresAt - Date.now()));
          const recheck = setInterval(() => {
            void authorize(req).then((current) => {
              if (!current) socket.destroy();
            });
          }, 30_000);
          socket.on('close', () => {
            clearTimeout(expiry);
            clearInterval(recheck);
            remote.destroy();
          });
          remote.on('close', () => socket.destroy());
          remote.on('error', () => socket.destroy());
          socket.on('error', () => remote.destroy());
        });
        socket.on('close', () => upstream.destroy());
        upstream.end();
      })().catch(() => socket.destroy());
    });
}
