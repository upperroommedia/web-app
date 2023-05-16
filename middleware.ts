import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { authentication } from 'next-firebase-auth-edge/lib/next/middleware';
import { serverConfig } from './config/server-config';

export async function middleware(request: NextRequest) {
  console.log(serverConfig.serviceAccount);
  return authentication(request, {
    loginPath: '/api/login',
    logoutPath: '/api/logout',
    apiKey: serverConfig.firebaseApiKey,
    cookieName: 'AuthToken',
    cookieSignatureKeys: ['secret1', 'secret2'],
    cookieSerializeOptions: {
      path: '/',
      httpOnly: true,
      secure: false, // Set this to true on HTTPS environments
      sameSite: 'strict' as const,
      maxAge: 12 * 60 * 60 * 24 * 1000, // twelve days
    },
    serviceAccount: serverConfig.serviceAccount,
    isTokenValid: (token) => Boolean(token),
    handleInvalidToken: async () => {
      console.log('User is not authenticated. Redirecting to login');
      // Avoid redirect loop
      if (request.nextUrl.pathname === '/login') {
        return NextResponse.next();
      }

      // Redirect to /login?redirect=/prev-path when request is unauthenticated
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      url.search = `redirect=${request.nextUrl.pathname}${url.search}`;
      return NextResponse.redirect(url);
    },
    handleValidToken: async ({ token, decodedToken }) => {
      console.log('Successfully authenticated', { token, decodedToken });
      return NextResponse.next();
    },
    handleError: async (error) => {
      console.error('Oops, this should not have happened.', { error });
      return NextResponse.next();
    },
  });
}

export const config = {
  matcher: [
    '/uploader:path*',
    '/admin:path*',
    '/api:path*',
    '/login:path*',
    '/logout:path*',
    '/api/login',
    '/api/logout',
  ],
};
