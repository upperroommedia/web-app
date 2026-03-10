# Staging Infrastructure Setup

This repository is now configured for staging-first promotions and selective Firebase deploys. Complete these one-time external setup steps before the first staging deployment.

## 1. Upgrade staging project billing (required)

App Hosting requires Blaze:

- [Upgrade `urm-app-staging` to Blaze](https://console.firebase.google.com/project/urm-app-staging/usage/details)

## 2. Create App Hosting backend in staging project

Run after Blaze is enabled:

```bash
firebase apphosting:backends:create --project urm-app-staging --location us-central1
```

When prompted, set backend id to `web-staging` and root dir to repository root (`.`).

## 2b. Disable automatic App Hosting rollouts (required)

Disable automatic rollouts for backend `web-staging` in Firebase Console so App Hosting only deploys when the staging workflow explicitly triggers a rollout:

- Open App Hosting backend settings for `web-staging`.
- Turn off automatic rollouts.

## 3. Configure App Hosting secrets for `apphosting.staging.yaml`

Create/grant each secret in `urm-app-staging`:

```bash
firebase apphosting:secrets:set ROLE_REQUEST_RECIPIENTS_STAGING --project urm-app-staging
firebase apphosting:secrets:set RUNTIME_ALERT_RECIPIENTS_STAGING --project urm-app-staging
firebase apphosting:secrets:set ADMIN_BASE_URL_STAGING --project urm-app-staging
firebase apphosting:secrets:set SUBSPLASH_EMAIL_STAGING --project urm-app-staging
firebase apphosting:secrets:set SUBSPLASH_PASSWORD_STAGING --project urm-app-staging
firebase apphosting:secrets:set DOLBY_API_KEY_STAGING --project urm-app-staging
firebase apphosting:secrets:set DOLBY_API_SECRET_STAGING --project urm-app-staging
firebase apphosting:secrets:set CLERK_SECRET_KEY_STAGING --project urm-app-staging
firebase apphosting:secrets:set ALGOLIA_SEARCH_API_KEY_STAGING --project urm-app-staging
```

If access is not auto-granted:

```bash
firebase apphosting:secrets:grantaccess <SECRET_NAME> --project urm-app-staging --backend web-staging
```

## 3b. Configure Cloud Functions secrets/env (staging)

SoundCloud publishing uses a Functions secret, not App Hosting env vars:

```bash
firebase functions:secrets:set SOUNDCLOUD_ACCESS_TOKEN --project urm-app-staging
```

Notes:
- `SOUNDCLOUD_ACCESS_TOKEN` is consumed by `uploadToSoundCloud`, `editSoundCloudSermon`, and `deleteFromSoundCloud`.
- App Hosting secrets in `apphosting.staging.yaml` do not automatically flow into Cloud Functions.

## 3c. Enable Google Sign-In in staging Auth (one-time)

If Google provider is not yet enabled in `urm-app-staging`, configure `google.com` default IdP config:

```bash
ACCESS_TOKEN=$(gcloud auth print-access-token)
curl -X POST "https://identitytoolkit.googleapis.com/v2/projects/urm-app-staging/defaultSupportedIdpConfigs?idpId=google.com" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "x-goog-user-project: urm-app-staging" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"clientId":"<GOOGLE_OAUTH_CLIENT_ID>","clientSecret":"<GOOGLE_OAUTH_CLIENT_SECRET>"}'
```

## 4. Provision staging databases (one-time)

Create Firestore default database:

```bash
gcloud firestore databases create --project=urm-app-staging --database='(default)' --location=us-central1 --type=firestore-native --quiet
```

Create Realtime Database instance (used by staging runtime config):

```bash
ACCESS_TOKEN=$(gcloud auth print-access-token)
curl -X POST "https://firebasedatabase.googleapis.com/v1beta/projects/251680231116/locations/us-central1/instances?databaseId=urm-app-staging-815ca" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "x-goog-user-project: urm-app-staging" \
  -H "Content-Type: application/json" \
  -d '{"type":"USER_DATABASE"}'
```

Create the default Realtime Database instance (required for Firebase CLI `database` deploy flows):

```bash
ACCESS_TOKEN=$(gcloud auth print-access-token)
curl -X POST "https://firebasedatabase.googleapis.com/v1beta/projects/251680231116/locations/us-central1/instances" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "x-goog-user-project: urm-app-staging" \
  -H "Content-Type: application/json" \
  -d '{"type":"DEFAULT_DATABASE"}'
```

Map RTDB deploy target to the staging instance:

```bash
firebase target:apply database rtdb urm-app-staging-815ca --project urm-app-staging
```

## 5. Configure GitHub OIDC for staging deploy workflow

Create a Workload Identity Provider and service account with Firebase deploy permissions, then add these repository secrets:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT_EMAIL`

## 6. Validate the pipeline

1. Open a PR from any feature branch into `staging` and confirm `staging-selective-deploy` passes.
2. Merge into `staging` and confirm selective deploy executes.
3. Confirm App Hosting rollout is triggered only when app-related files change.
4. Open PR `staging -> main` and confirm `main-from-staging` passes.
5. Open PR `feature -> main` and confirm `main-from-staging` fails.
