# Performance Sweep - 2026-02-23

## Update - 2026-02-24 (Post-Fix Validation)

### Test setup
- `dev` traces were captured on `http://localhost:3000` after restarting dev/emulators and running `npx ts-node --skip-project scripts/create-dev-admin.ts`.
- `production` traces were captured on `http://localhost:3101` via `pnpm build` + `pnpm start -p 3101`.
- Note: admin routes are not accessible in `next start` local mode with the dev-login shortcut (it is development-only), so admin deep-path validation remains on `:3000`.

### Current status of previously tracked issues
- Fixed: `/admin/sermons` N+1 user lookups.
  - Latest resource sample: `getuser=0`, `getusersbyids=1`, `firestore listen=3`, `total resources=58`.
- Fixed: `/admin/users` duplicate `listusers` calls.
  - Latest resource sample: `listusers=1`, `total resources=37`.
- Improved: first-play regression/remount issue is no longer reproducing after `dc5a868`.

### Still open (high priority)
- `/admin/sermons` still has high render-delay dominated LCP.
  - Trace A: LCP `4788 ms` (TTFB `231 ms`, render delay `4557 ms`), CLS `0.19`.
  - Trace B: LCP `4467 ms` (TTFB `234 ms`, render delay `4233 ms`), CLS `0.19`.
- `/admin/sermons` still shows notable CLS.
  - Worst shift cluster score `~0.193` with a large shift event `~0.1875`.
  - CLS insight flags font load and non-composited MUI autofill animation (`mui-auto-fill-cancel`) in the shift window.
- Forced reflow remains present on admin pages.
  - Sermons trace: `#onResize` in vidstack chunk contributes `~23 ms` (plus smaller reflows).
  - Users trace: `#onResize` contributes `~34 ms`.
- Third-party payload remains significant.
  - GTM transfer remains `~539.9 kB` and main-thread work `~11-12 ms`.
  - On sermons trace, DevTools aggregates `127.0.0.1` traffic at `~3 MB`.

### Healthy/acceptable in latest run
- `/admin/users`: LCP `574-606 ms`, CLS `0.01`.
- `/admin/series`: LCP `607 ms`, CLS `0.00`.
- `/` (dev): LCP `737 ms`, CLS `0.01`.
- `/login` on `next start` (`:3101`): LCP `~41 ms`, CLS `0.00`.

### Recommended next actions
1. Reduce `/admin/sermons` render work (virtualized list + defer non-critical filter/facet blocks).
2. Address CLS in sermons list (reserve stable heights for loading->loaded card transitions, review MUI autofill animation impact).
3. Reduce `#onResize` pressure from player/layout observers (throttle with `requestAnimationFrame`, avoid repeated sync layout reads).
4. Defer GTM and other non-essential third-party scripts on admin routes until idle/interaction.
5. Re-run this same sweep in production-authenticated mode once a local prod auth path exists.

## Scope
- Environment: local dev app at `http://localhost:3000` (Chrome DevTools MCP).
- Flows tested:
  - `/`
  - `/admin/sermons`
  - `/admin/series`
  - `/admin/users`
  - `/admin/topics`
  - YouTube upload/trimmer load flow on `/`
- Tooling used:
  - Chrome DevTools Performance Insights (LCP/CLS/forced reflow/network/3rd party/cache).
  - Runtime inspection via `performance.getEntriesByType('resource')`.
  - Console/network sweep for warnings and noisy behavior.

## Findings (Prioritized)

### 1) High impact: `/admin/sermons` has very high LCP caused by render delay, not network
- Evidence:
  - Trace 1: LCP `5856 ms`, render delay `5530 ms`.
  - Trace 2: LCP `4366 ms`, render delay `4117 ms`.
  - LCP element is text (not an image request), so this is mostly client render/hydration delay.
- Likely cause:
  - Large initial UI work (many cards/filter controls), heavy post-load computation, and repeated async fetches.
- Recommendations:
  - Virtualize the sermon list and render above-the-fold rows first.
  - Move expensive filtering/grouping work off render path (`useMemo`, indexed maps, precomputed server payloads).
  - Defer non-critical panels (facet sections) behind interaction or idle.

### 2) High impact: `/admin/sermons` performs N+1 user fetches on load
- Evidence:
  - Resource inspection after load: `101` resources total, `40` calls to `/urm-app/us-central1/getuser`.
  - Multiple Firestore listen channel calls in the same load cycle.
- Likely cause:
  - Per-row user lookup pattern during list render.
- Recommendations:
  - Batch user lookups in one endpoint call.
  - Denormalize required display fields onto sermon docs for admin lists.
  - Add request dedupe/cache layer keyed by user id.

### 3) Medium impact: `/admin/users` duplicate fetch on initial render
- Evidence:
  - Resource inspection: `2` calls to `/urm-app/us-central1/listusers` per load.
- Likely cause:
  - Duplicate effect path or a missing request guard/idempotency in client init.
- Recommendations:
  - Ensure one-shot fetch semantics (`useRef` guard, query library dedupe, or server component fetch).
  - If React Strict Mode double-invocation is involved in dev, verify production still issues single request.

### 4) Medium impact: forced reflow hotspots across routes
- Evidence:
  - `/`: forced reflow total `120 ms` (includes MUI date picker selection sync and textarea autosize recalcs).
  - `/admin/*`: repeated `#onResize` forced reflow from media/vidstack chunks (`~23-44 ms`).
- Likely cause:
  - Layout reads after writes during resize or input updates.
- Recommendations:
  - Batch DOM reads/writes and throttle resize handlers with `requestAnimationFrame`.
  - Avoid synchronous geometry reads in hot paths.
  - Isolate autosizing textareas/date controls from unrelated rerenders.

### 5) Medium impact: LCP image discovery failure for top logo on multiple routes
- Evidence:
  - DevTools insight repeatedly flags LCP discovery failures for `/URM_icon.png`:
    - missing `fetchpriority=high`
    - lazy/discovery checks failing
  - Next.js console warning recommends `priority`.
- Recommendations:
  - Mark above-the-fold logo image with `priority` (Next `Image`) and explicit size.
  - Ensure the image is present in initial HTML when possible.

### 6) Medium impact: upload page document latency is high (slow initial HTML response)
- Evidence:
  - `/` trace: document request total `1100 ms`, TTFB `1014 ms`.
  - DevTools estimated savings: `~913 ms` for FCP/LCP if improved.
- Recommendations:
  - Audit server/emulator latency in page bootstrap path.
  - Reduce synchronous work before first byte.
  - Cache static shell aggressively where feasible.

### 7) Medium/low impact: third-party weight is significant in admin routes
- Evidence:
  - Google Tag Manager transfer: `~539 KB`.
  - Additional Google SDK traffic observed (up to `~620 KB` bucket on sermons route).
- Recommendations:
  - Defer analytics/third-party boot until post-interaction or idle.
  - Gate non-essential third-party scripts on admin routes.

### 8) Low/medium impact: speaker images have short cache lifetime for high-repeat assets
- Evidence:
  - Many speaker images from GCS served with TTL `3600` seconds.
- Recommendations:
  - Use long-lived immutable caching for versioned image URLs.
  - Keep mutable URLs short-lived only when actively edited.

### 9) Reliability/perf noise: YouTube iframe postMessage origin mismatch warning
- Evidence:
  - Console warning after loading trimmer:
    - `Failed to execute 'postMessage'... target origin ... does not match recipient ...`
- Recommendations:
  - Audit `postMessage` target origin and only send to active iframe origin.
  - Eliminate unnecessary message retries in inactive states.

### 10) Reliability/perf noise: debug logs still active in trimmer flow
- Evidence:
  - Console emits repeated `[TRIMMER_DEBUG]` entries during YouTube flow.
- Recommendations:
  - Gate debug logs behind development flag and strip in production bundles.

## Route Snapshot Summary
- `/admin/sermons`: main hotspot (LCP 4.3s-5.8s, render-delay dominated, N+1 fetch pattern).
- `/`: acceptable LCP but high document latency and forced reflow in form controls.
- `/admin/series`, `/admin/users`, `/admin/topics`: generally fast LCP (~0.57s-0.63s), but reflow + request hygiene issues remain.

## Suggested Execution Order
1. Remove N+1 `/getuser` on sermons page and re-test LCP.
2. Virtualize/defer sermons list content and facet rendering.
3. Fix duplicate `/listusers` fetch on users page.
4. Apply `priority` to above-the-fold logo image.
5. Clean resize/layout thrash and remove debug noise.
6. Re-run traces in production build profile (`next build && next start`) for final validation.
