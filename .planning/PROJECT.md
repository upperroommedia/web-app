# Upper Room Media Web App

## What This Is

Upper Room Media Web App is a brownfield, production-oriented media operations platform built on Next.js and Firebase. It supports authenticated admin workflows for uploading sermons, managing lists and series, processing audio, and publishing content to external platforms like Subsplash and SoundCloud. The system also maintains denormalized Firestore relationships and bundle-based read optimizations to keep editorial workflows usable at scale.

## Core Value

The platform must provide a trustworthy end-to-end publishing pipeline: admins can move media from draft to external publication safely, with correct metadata and predictable operational behavior.

## Requirements

### Validated

- [x] Role-based admin access controls and capability checks are present across UI and backend callable paths.
- [x] Sermon/list/series content modeling and Firestore converters are established and in active use.
- [x] Audio processing pipeline exists (task generation, processing handlers, storage outputs, progress tracking).
- [x] External publishing integrations exist for Subsplash and SoundCloud.
- [x] Search and discovery flows exist (Algolia-backed with local/dev fallback behavior).
- [x] Bundle generation and consumption paths exist (topic/subtitle/bible/sunday/latest bundle pipeline).
- [x] Series subtitle derivation from published item state is implemented in current milestone work.

### Active

- [ ] Complete Phase 01 plan 02 to finalize independent series publishing flow and combined publish ergonomics.
- [ ] Complete Phase 02 plan 01 to enforce fail-closed external API behavior in emulator mode with deterministic mocks.
- [ ] Remove high-risk unauthenticated or weakly-guarded function surfaces identified in codebase concerns.
- [ ] Address high-risk data integrity issues from unawaited/misused Firestore batch commit patterns.
- [ ] Keep current architecture stable while reducing operational risk and regression surface.

### Out of Scope

- Full product redesign or migration away from Firebase/Next.js in this milestone window.
- Re-platforming the UI from Pages Router to App Router as part of current reliability work.
- Broad feature expansion (new end-user feature families) before reliability/security hardening is complete.

## Context

- Monorepo with root Next.js app and `functions` workspace package.
- Core code locations:
  - Web routes and admin workflows: `pages/`, `components/`
  - Auth/state and client adapters: `context/`, `firebase/`, `utils/`
  - Backend callables/listeners/tasks: `functions/src/`
  - Shared domain models: `types/`, `shared/`
- Current GSD active phase directories:
  - `.planning/phases/01-series-subtitle-automation/`
  - `.planning/phases/02-dev-external-api-mocking/`
- Refreshed codebase map documents live in `.planning/codebase/*.md` (updated 2026-02-28).

## Constraints

- **Runtime**: Node 22 is required in root and functions packages.
- **Platform**: Firebase (Firestore, Functions, Storage, Auth, RTDB) remains the system backbone.
- **Compatibility**: Changes must preserve existing admin workflows for sermons, lists, series, and publishing paths.
- **Safety**: Local development must not produce unintended production side effects.
- **Data consistency**: Denormalized relationship updates must remain correct under listener/callable interactions.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Treat this as a brownfield platform, not a greenfield feature app | Existing code already delivers broad production workflows | ✓ Good |
| Keep current milestone focused on publishing correctness and dev safety first | Highest leverage for reducing regressions and operator risk | ✓ Good |
| Use refreshed codebase map as source of truth for planning docs | Avoid narrow planning context and capture full system reality | ✓ Good |
| Follow with hardening work for auth/rules/batch integrity concerns | P0/P1 concerns materially affect reliability and safety | - Pending |

---
*Last updated: 2026-02-28 after $gsd-map-codebase refresh*
