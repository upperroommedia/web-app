# Firestore Trigger Email function kit

Repository-owned migration of the Firebase `firestore-send-email` extension to a
standard Cloud Functions for Firebase (2nd generation) function kit. Export:
`processQueue`. The npm replacement `@firebase-function-kits/firestore-send-email`
version 0.0.1 contained an empty JavaScript entrypoint when checked, so it cannot
replace a working email delivery service.

## Provenance

Adapted from the official Apache-2.0 Firebase Extensions implementation,
`firestore-send-email` version 0.2.10, at commit
`300a93fae55e35da72dd27511da4e933fed36972`:
https://github.com/firebase/extensions/tree/300a93fae55e35da72dd27511da4e933fed36972/firestore-send-email/functions

Original Google copyright notices and the Apache license are retained. The
upstream SMTP/OAuth/SendGrid adapters, payload validation, Handlebars templates,
recipient lookup, TTL metadata, and delivery state machine remain supported.
Local changes adapt parameter/secret/IAM declarations to the function-kit API,
use modular Admin SDK imports, prevent concurrent cold-start initialization,
bound SMTP connection/read waits, preserve the transaction delivery lock,
remove logging of email bodies and recipient details, fail closed on malformed
TLS settings, and fix stale/deleted template caching and unbounded listener waits.

## Migration and configuration

Use the Firebase migration guide and `firebase kit install` with this local
package directory. Export the existing extension configuration first. Retain
all existing parameter values and `FIREBASE_SECRET_REF_SMTP_PASSWORD` so the
same managed secret is used. Do not put secret material in tracked files.

The queue path and trigger settings are `MAIL_COLLECTION`, `DATABASE`, and
`LOCATION`. Remaining configuration names match the extension:
`DATABASE_REGION`, `SMTP_CONNECTION_URI`, `DEFAULT_FROM`, `DEFAULT_REPLY_TO`,
`USERS_COLLECTION`, `TEMPLATES_COLLECTION`, `TTL_EXPIRE_TYPE`,
`TTL_EXPIRE_VALUE`, `TLS_OPTIONS`, `AUTH_TYPE`, `HOST`, `OAUTH_PORT`,
`OAUTH_SECURE`, `USER`, `CLIENT_ID`. `SMTP_PASSWORD` is a managed secret.
When `AUTH_TYPE=OAuth2` is set in the instance configuration, `CLIENT_SECRET`
and `REFRESH_TOKEN` are additionally declared and bound as managed secrets.
Deploying a username/password instance does not require empty OAuth secrets.
The kit declares `roles/datastore.user`; the CLI provisions secret access from
the bindings. Optional legacy Eventarc custom events are supported when the
channel is explicitly configured; that setup requires event publisher IAM.

Exported `FUNCTION_DEFAULT_REGION` and `EXT_MIGRATED_SYSTEM_*` resource/network
settings are preserved through `setGlobalOptions` and explicit trigger settings,
including memory, minimum/maximum instances, timeout, VPC, ingress, CPU, labels,
and service account. Unspecified network enum values are left unset.
Cloud Functions uses Node 22, with defaults of at most 10 instances and 20 concurrent requests per
instance (1 for a fractional CPU). The Firestore transaction claims each queue document before SMTP
sending. The delivery lease defaults to 180 seconds, above the default 120 second handler
budget, and extends to the exported timeout plus 60 seconds; SMTP connection/greeting timeouts are 15 seconds and socket inactivity
timeout is 45 seconds. SMTP failures set `delivery.state=ERROR`; set it to
`RETRY` explicitly to reattempt, as with the extension. Provider submission and
Firestore status writes cannot form an atomic transaction: retain the existing
expired-lease ERROR behavior instead of automatically resending an ambiguous
submission and duplicating an email.

Deploy and validate the replacement with mocked/local SMTP tests before
uninstalling the extension. Avoid having two active handlers on the same email
queue during migration. No real emails are needed for package validation.
Firestore TTL must remain enabled on `delivery.expireAt` when configured.

## Verification

`npm ci` and `npm test` in this directory build the package and run unit
regressions with all outbound delivery mocked. Tests cover provider settings,
payload validation, attachment/template data, simultaneous queue events, stale
event replay, delivery errors and explicit retries, expired leases, removed
queue records, HTML escaping, stale/deleted templates, and listener failures.
Production dependencies use current stable releases. Zod 4's supported `zod/v3`
compatibility entrypoint preserves upstream validation/error behavior. Nodemailer
10's transport settings are passed in transport options, rather than mail
defaults. The compiled npm package contains source declarations and license.

https://firebase.google.com/docs/extensions/users/migrate
https://firebase.google.com/docs/extensions/publishers/migrate

The lockfile is generated from a clean Linux Node 22 environment so platform
optional dependencies are present for Cloud Build. Before packing/deploying run
`npm ci` and `npm run build`; compiled `lib/` is shipped with the package. There
is no install-time `prepare` hook, so a production-only install can use the
compiled functions without requiring TypeScript. Both Linux `npm ci` and
`npm ci --omit=dev` are verified.
