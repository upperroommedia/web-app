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
```

If access is not auto-granted:

```bash
firebase apphosting:secrets:grantaccess <SECRET_NAME> --project urm-app-staging
```

## 4. Configure GitHub OIDC for staging deploy workflow

Create a Workload Identity Provider and service account with Firebase deploy permissions, then add these repository secrets:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT_EMAIL`

## 5. Validate the pipeline

1. Open a PR from any feature branch into `staging` and confirm `staging-selective-deploy` passes.
2. Merge into `staging` and confirm selective deploy executes.
3. Open PR `staging -> main` and confirm `main-from-staging` passes.
4. Open PR `feature -> main` and confirm `main-from-staging` fails.
