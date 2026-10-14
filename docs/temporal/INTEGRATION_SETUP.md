# Administrative credential setup

SoundCloud connection setup remains synchronous administrative configuration under either open legacy or open Temporal accounts ownership. A one-time OAuth code is not safe to replay in an automatically retried workflow. YouTube cookie configuration uses the same `withAdministrativeCredentialSetupLease` fence under the media domain, with only the literal `setYouTubeCookies` operation accepted. This credential lease never permits queue dispatch or bypasses legacy ownership for probes or processing.

Both SoundCloud connection callables require an administrator and acquire a release-fenced, drain-visible admission lease before session or credential changes. Pauses reject before work. An uncertain token exchange retains a `needs_attention` admission and requires new explicit consent; never retry the same code or treat a failed request as proof of no provider effect. Successful credential persistence and matching pending-session consumption commit atomically. An active OAuth exchange serializes against other connections and the existing refresh-token lease.

## Retired bulk tag maintenance

Repository call-site inventory found `tagitemsinlist` and `updatesubsplashtag` only in their integrations exports and historical handlers; no UI, script or documentation invokes them. Their handlers and exports are removed. The former reused unawaited write batches and the latter mixed bulk canonical changes with untracked provider effects and reported partial failure as success. The unrelated `updateSubsplashTagsHelper` remains because `fixPhantomListItems` uses it. Normal sermon updates use the reviewed durable publishing commands.

Removing an export does not remove an existing deployed function until the deployment's deletion step runs. After reviewing the exact staging inventory and source deployment, retire only these two functions using the Firebase CLI:

```sh
firebase functions:delete tagitemsinlist updatesubsplashtag --region us-central1 --project urm-app-staging --force
```

Production deletion is a separate approved production rollout step with `--project urm-app`. Do not run either command as a background cleanup or delete unrelated integration handlers. Verify the deployed function inventory and confirm both names are absent afterward. No remote deletion was performed while preparing this source change.

## Abandoned SoundCloud consent attempts

Each code redemption records a protected `oauthAttempts/<attempt-id>` audit alongside its ownership claim. Production callables link the audit to their actual effects-started admission lease. The original claim time comes from the Firestore server read timestamp; its abandonment boundary is exactly 120 seconds later. Both OAuth callables have a 60-second runtime limit.

Starting an explicit new connection may supersede an expired claim after that boundary. It atomically records the original attempt as superseded with an unknown outcome and fences its old owner before creating the new consent session. The old authorization code stays unusable; a late old token response cannot overwrite the new connection. Live attempts block new consent. Failed cleanup leaves the original attempt recoverable through this same path. Missing or malformed claim/audit identity requires operator review.

Supersession does **not** prove the provider performed no work, complete the original admission, or make it drained. Its original `active` or `needs_attention` admission remains visible and needs audited operator review before a future ownership change. No expiry timer silently clears that journal. Expired refresh leases can be fenced when a new OAuth grant is claimed; a live refresh lease still blocks it, and the existing refresh result comparison prevents a late old refresh from replacing new credentials.
