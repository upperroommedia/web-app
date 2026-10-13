# Temporal platform

## Hosting comparison, checked 2026-10-12

Temporal Cloud is the selected orchestration service. Production and staging namespaces are active in GCP `us-central1`, matching both Firebase App Hosting backends. Each namespace uses a single region with no disaster-recovery replica. The staging worker server has been provisioned; application worker deployment remains pending. Production worker infrastructure has not yet been provisioned.

[Temporal's current direct pricing](https://temporal.io/pricing) lists no base monthly fee, $50 per million actions, $0.042/GB-hour of active history, $0.00105/GB-hour of retained history and developer support at 10% of usage. Using 730 hours/month gives these illustrative estimates, before taxes, networking, HA add-ons or discounts:

| Monthly actions | Average active history | Average retained history | Orchestration plus 10% support |
| --------------- | ---------------------- | ------------------------ | ------------------------------ |
| 200,000         | 0.1 GB                 | 5 GB                     | $18.59/month                   |
| 1,000,000       | 1 GB                   | 10 GB                    | $97.16/month                   |

These are scenarios, not a forecast of this application's usage. Cloud actions include retries, signals and timers; job counts alone cannot determine the bill. Audio and image bytes remain in object storage rather than workflow histories. Event-driven review wakeups avoid repeatedly polling indefinitely unresolved provider operations.

The selected worker hosting is one `e2-standard-4` Compute Engine server per environment, running single-node K3s with one replica per worker role. Allow approximately $150–$180/month per environment: about $98 for compute at the [published US-central1 rate](https://cloud.google.com/products/compute/pricing/general-purpose), $50 for a dedicated 500 GiB balanced scratch disk at the [published disk rates](https://cloud.google.com/compute/disks-image-pricing), plus boot disk and networking. The scratch disk must provide at least 400 GiB of usable capacity; staging uses a 470 GiB disk to fit its current regional quota, verified after formatting. Staging and production together therefore provision approximately $300–$360/month of worker infrastructure, plus measured Temporal Cloud usage. There is no GKE cluster, self-hosted Temporal server, PostgreSQL service or multi-zone recovery fleet in this deployment.

Temporal Cloud runs orchestration; the worker servers run this application's activities. Dedicated staging and production namespaces, authenticated connections, isolated provider mutation authority and worker deployment provenance remain required. See [the Cloud deployment guide](CLOUD.md) for the selected simple hosting setup. A server failure pauses work until that server returns; Temporal preserves workflow history. Deployments must respect actual server capacity and drain existing work before replacement when both versions cannot fit.

## Self-hosted fallback

Older self-hosted templates describe separate Kubernetes and PostgreSQL clusters. They are retained as an optional fallback and have not been provisioned; they are not prerequisites for the selected Cloud deployment. Missing deployment inputs fail validation. The existing media VM remains separate.

Copy the matching environment example to an operator-controlled JSON file outside the repository and fill its explicit infrastructure inputs. Render without changing remote infrastructure:

```sh
node scripts/temporal-platform.mjs render --config /secure/staging.json --peer /secure/production.json --output /tmp/temporal-staging
```

See [the optional self-hosted operations guide](../../docs/temporal/OPERATIONS.md) for this fallback's secrets, database migrations, deployment, versioned workers, backups and recovery. These database and restore steps do not apply to the selected Cloud path. Example values contain no working credentials and cannot deploy.
