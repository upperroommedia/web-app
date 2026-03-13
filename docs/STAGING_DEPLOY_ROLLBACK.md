# Staging Rollback Runbook

## App Hosting rollback

1. Choose the commit you want to restore (from git history or previous workflow runs).
2. Create a rollback rollout from that commit:
   ```bash
   firebase apphosting:rollouts:create web-staging --project urm-app-staging --git-commit <commit_sha> --force
   ```

## Functions/rules rollback

1. Re-run `staging-selective-deploy` workflow against the target rollback commit.
2. Use `workflow_dispatch` with `force_full_redeploy=true` if the rollback includes shared backend changes.
3. If needed, redeploy individual targets manually:
   ```bash
   firebase deploy --project urm-app-staging --only functions:core
   firebase deploy --project urm-app-staging --only functions:media
   firebase deploy --project urm-app-staging --only functions:image
   firebase deploy --project urm-app-staging --only functions:integrations
   firebase deploy --project urm-app-staging --only firestore:rules,firestore:indexes
   firebase deploy --project urm-app-staging --only database
   firebase deploy --project urm-app-staging --only storage
   ```

## Validation after rollback

1. Verify App Hosting staging URL serves the expected build.
2. Verify callable functions and Firestore reads/writes hit `urm-app-staging`.
3. Check workflow summary artifacts for deployed targets and command results.
