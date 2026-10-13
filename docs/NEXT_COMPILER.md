# Next.js compiler and cold navigation

The web application uses Next.js 16.4 with the supported webpack compiler for development, production builds, CI builds, and bundle analysis. Keep these scripts consistent in `apps/web/package.json`.

The Temporal UI browser tests exposed a Turbopack dependency registration failure during login followed by client navigation to a sermon detail page: Material UI Typography or Card was imported, but its module factory was unavailable. The generated factory existed in other chunks, while the detail page's dependency manifest omitted those chunks. This reproduced after a clean build directory and in fresh browser contexts with HTTP caching both enabled and disabled. Disabling Sentry's build wrapper or Turbopack's side-effect inference did not resolve it. The same navigation and publish lifecycle passed with webpack, with Sentry instrumentation enabled.

`apps/web/tests/cold-navigation.spec.ts` exercises real authenticated navigation in both ordinary and cache-disabled browser contexts. It checks that publishing controls render and that neither missing module factories nor duplicate Sentry Replay initialization occur. The publish admission lifecycle test additionally verifies that an accepted, completed task aging out of the bounded history does not leave publishing disabled.

Before returning to Turbopack, run those browser tests against the proposed stable Next.js version and check cold navigation against its production output. Do not move network interception until after navigation, replace Material UI imports to hide the failure, or treat a successful build alone as runtime verification.

Official references: [Next.js compiler selection](https://nextjs.org/docs/app/api-reference/turbopack#using-webpack-instead) and [client instrumentation](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client).

## Production browser check

Build with public synthetic Firebase configuration in CI: `NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-temporal-ci`, `NEXT_PUBLIC_FIREBASE_API_KEY=synthetic-public-browser-test-key`, and `NEXT_PUBLIC_FIREBASE_APP_ID=1:123456789:web:synthetic`. No Firebase or Sentry credentials are required. The browser test blocks every network origin except its local server, including Firebase, Sentry, and publishing providers.

After `pnpm --dir apps/web build`, serve the actual standalone output:

```sh
cp -R apps/web/public apps/web/.next/standalone/apps/web/public
cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
PORT=3002 HOSTNAME=127.0.0.1 node apps/web/.next/standalone/apps/web/server.js
```

In another terminal, run both configured browser profiles:

```sh
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3002 PLAYWRIGHT_PRODUCTION_SMOKE=1 \
  pnpm --dir apps/web exec playwright test tests/production-cold-navigation.spec.ts --workers=1 --reporter=line
```

This checks a fresh signed-out browser: login loads, the protected sermon detail chunk loads successfully during client navigation, and the user returns safely to login without runtime errors. It does not contact live accounts or replace the authenticated projection and admission lifecycle checks against the local emulators.
