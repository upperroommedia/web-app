# Web App Agent Notes

## Post-Build Dev Workflow (Conditional)

Only if you run `pnpm build` and then want to continue in dev mode for exploration/testing, follow this sequence:

1. Stop the current dev process.
2. Run `pnpm dev` from `web-app`.
3. After dev is ready, open another terminal in `web-app` and run:
   `npx ts-node --skip-project scripts/create-dev-admin.ts`

This ensures the auth login user exists for local testing.
