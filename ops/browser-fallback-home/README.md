# Browser Fallback Home Host

This stack is for running the browser-fallback service on a non-cloud Linux machine that is reachable over ZeroTier and fronts traffic through the existing named Cloudflare Tunnels.

## Layout

- `compose.yaml`
  - runs one browser-fallback container and one `cloudflared` container per environment
- `tunnels/`
  - checked-in tunnel configs for the existing production and staging hostnames
  - tunnel credential JSON files are intentionally not committed and must be copied in alongside these configs
- `env/`
  - not committed
  - contains one env file per environment with Firebase credentials and browser-fallback settings
- `context/`
  - not committed
  - contains the minimal browser-fallback build context assembled by `scripts/prepare-browser-fallback-home-context.sh`

## Staging Bring-Up

1. Prepare a minimal Docker build context locally:

   ```bash
   ./scripts/prepare-browser-fallback-home-context.sh ops/browser-fallback-home/context
   ```

2. Create `ops/browser-fallback-home/env/browser-fallback-staging.env` with the staging Firebase values and shared secret.

3. Copy in the staging tunnel credential file:

   ```bash
   cp ~/.cloudflared/e2e168f5-5dbc-4048-834e-a38084a8b85b.json ops/browser-fallback-home/tunnels/
   ```

4. Sync the directory to the home host and run:

   ```bash
   docker compose --profile staging up -d --build
   ```

5. Stop any other active connector for the staging tunnel so traffic only lands on the home host.

6. Verify the public hostname:

   ```bash
   curl https://browser-fallback-staging.upperroommedia.org/session-status
   ```

## Production

Repeat the same steps with:

- `env/browser-fallback-production.env`
- `tunnels/49665e85-59a9-4323-b92c-4e1db0e4c33e.json`
- `docker compose --profile production up -d --build`

Do not switch production traffic until staging passes the signed `/fallback` YouTube test.
