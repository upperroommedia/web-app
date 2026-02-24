# Testing Patterns

**Analysis Date:** 2026-02-24

## Test Framework

**Runner:**
- Jest + `ts-jest` for functions and integration-style emulator tests
- Playwright for browser E2E tests

**Assertion Library:**
- Jest built-in `expect` in functions tests
- Playwright test assertions (`expect`) in E2E specs

**Run Commands:**
```bash
pnpm test:e2e                                  # Root Playwright suite
pnpm test:e2e:headed                           # Headed Playwright run
cd functions && pnpm test                      # Jest via firebase emulators:exec
cd functions && pnpm test:verbose              # Verbose test run
```

## Test File Organization

**Location:**
- Functions tests in `functions/src/test/` grouped by feature:
  - `addToList/`
  - `removeFromList/`
  - `series/`
  - `soundcloud/`
- Playwright tests in root `tests/`
- Extra helper scripts in `tests/helpers/` and `test/`

**Naming:**
- Unit/integration: `*.test.ts`
- E2E: `*.spec.ts`

## Test Structure

**Suite Organization Pattern (functions):**
```typescript
describe('feature', () => {
  beforeEach(async () => {
    // reset emulator/mocks
  });

  it('handles success case', async () => {
    // arrange
    // act
    // assert
  });
});
```

**Suite Organization Pattern (E2E):**
```typescript
test.describe('YouTube trimmer', () => {
  test('shows controls for valid URL', async ({ page }) => {
    // arrange
    // act
    // assert
  });
});
```

## Mocking

**Framework:**
- Jest mocks and feature-specific mock helpers in `functions/src/test/**/mocks.ts`

**Patterns:**
- External integrations mocked (e.g., SoundCloud upload client)
- Stateful test doubles for Subsplash behavior in add-to-list tests
- Firebase emulator setup from shared `functions/src/test/setup.ts`

**What is mocked frequently:**
- External APIs (Subsplash/SoundCloud interactions)
- Integration edge cases (network failures, retry behavior)

**What stays real in tests:**
- Firestore emulator-backed data paths for transaction and concurrency behavior

## Fixtures and Factories

**Test data helpers:**
- Functions feature helpers (e.g., `functions/src/test/addToList/firestoreHelpers.ts`)
- Playwright helper `tests/helpers/seedPlayableSermon.ts` seeds and cleans Firestore test data

**Environment setup:**
- Test setup ensures emulator hosts and project IDs are set before Admin SDK initialization

## Coverage

**Requirements:**
- No explicit coverage threshold detected in configs
- Focus appears to be behavioral confidence over coverage gates

**Gaps:**
- No dedicated client unit test framework/config found for React components
- E2E focuses on critical flows, not full UI breadth

## Test Types

**Unit/Service Tests (functions):**
- Validate function behavior, permission checks, and integration call shapes

**Integration Tests (functions + emulator):**
- Firestore transaction/retry/concurrency scenarios for list/series operations

**E2E Tests (Playwright):**
- Auth + uploader + trimmer + audio player UX paths
- Includes desktop and mobile-chrome projects

## Common Patterns

**Async testing:**
- `async/await` throughout tests
- `await expect(...).rejects` for failure paths

**Error testing:**
- Assert specific Firebase `HttpsError` code/message semantics
- Explicit checks for unauthenticated/unauthorized role access

**UI test reliability tactics:**
- Deterministic seeding/cleanup helpers
- Explicit waits for visible controls and dynamic readiness states

---

*Testing analysis: 2026-02-24*
*Update when test frameworks or execution strategy changes*
