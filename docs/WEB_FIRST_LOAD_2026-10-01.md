# Web first load investigation (2026-10-01)

## Measured baseline

Production is Firebase App Hosting `web-prod` with zero minimum instances, one CPU, 512 MiB of memory, and concurrency 80. The production build prerenders every browser page; only `/404` and the four `/api/*` handlers render on demand. The build took about four minutes, including 53 seconds of Next.js compilation. Build duration is separate from request latency.

Cloud Run request and instance-start logs for the previous 24 hours showed 36 instance starts. For HTML and API requests matched to a new instance, median latency was 6.50 seconds (13 requests); warm requests had an 11 ms median (73 requests). A browser request to `/` measured 5.12 seconds to first byte while cold, then 0.15–0.24 seconds on warm requests. Repeated HTML responses had no `Cache-Control` header and `cdn-cache-status: miss`, so even prerendered pages reached Cloud Run.

The initial auth screen used `next/image` for `/URM_icon.png`. Its custom loader sent the 8.5 KB static logo through `/_fah/image/process`; one fresh browser run waited 2.43 seconds for this image before first contentful paint at 2.76 seconds. The generated 640 px WebP was 27.4 KB. Image proxy requests accounted for 469 of 1,073 recent web service requests. Cold image proxy requests had a 7.75-second median; the image extension itself had a 171 ms median, so the web service's cold/proxy path dominated.

An unauthenticated visit to `/` downloaded about 1.04 MB of compressed JavaScript across 44 scripts before and after client redirect to `/login`. It eagerly included the uploader despite the visitor lacking a session. Auth hydration also had a fixed 500 ms timer. In the same headless Chrome flow, the changed local production build downloaded about 805 KB across 39 scripts. The local and remote paint times are not directly comparable because network paths differ.

Sentry Discover and Cloud Trace had no usable transaction traces for this period. Cloud Run instance/request logs and browser resource timing supplied the latency breakdown.

## Changes

- Cache only prerendered, auth-neutral browser page shells at the App Hosting CDN for one hour, with five minutes of stale revalidation. API routes and the image processor remain outside this policy. Browsers revalidate on each navigation. The one-hour freshness window is a tradeoff: a rollout may leave an older shell at an edge until it expires.
- Give the local logo and default avatar explicit CDN freshness and serve local public images directly instead of passing them through the image extension. Remote uploaded artwork still uses the image processor.
- Remove the fixed 500 ms auth timer and avoid a duplicate token lookup.
- Load the full uploader only after the user is authenticated and has upload permission.

The global Vidstack player still contributes to initial JavaScript. Its context is used by sermon controls, so deferring the wrapper would remount pages or break those controls. A separate refactor is needed for that path.

## Verification and remaining limit

The local production build succeeded and identified all browser pages as static. `next start` returned the new public CDN policy for `/`, `/login`, `/admin/sermons`, and a sermon detail page, while `/api/editSermon` did not receive it. Browser inspection of the local build showed no image proxy requests for the auth logo. After production rollout, check a page with two sequential requests for a CDN miss followed by a hit and `Age`, then check that a first browser visit still completes auth and displays the intended page.

An edge's first request after its cache expires can still start a zero-instance service. Eliminating that last cold request without a warm instance would require serving the static shell from a static hosting origin, with API routes kept on a serverless backend.

References: [Firebase App Hosting caching](https://firebase.google.com/docs/app-hosting/optimize-cache), [Next.js caching on self-hosted deployments](https://nextjs.org/docs/pages/guides/self-hosting).
