# Image Processing API function kit

Local replacement for `invertase/image-processing-api`, following [Firebase's self-created kit migration](https://firebase.google.com/docs/extensions/users/migrate) and [publisher conversion guide](https://firebase.google.com/docs/extensions/publishers/migrate). The latest CLI cannot automatically migrate this instance because it has no official replacement package. Source was forked from Invertase commit `f3a121f68d23c429731b8c26859109d322874c09`; the original Apache-2.0 license and copyright notices are included in `LICENSE` and `NOTICE`.

## Configuration and deployment

`source/` is an independent Node.js 22 Cloud Functions codebase. Its exported `handler` is a second-generation public HTTP function. Use Firebase CLI >=15.32.0 and register it as a local function kit with an instance configuration directory. Export the installed extension configuration with `firebase ext:export --mode functions --instance image-processing-api --kit-instance image-processing-api --project PROJECT_ID` rather than copying values by hand.

The parameter names remain `CLOUD_STORAGE_BUCKET`, `CORS_ORIGIN_ALLOW_LIST` (default `*`), and `HOSTNAME` (default empty). `FUNCTION_DEFAULT_REGION` sets the deployment region, falling back to the original `LOCATION` when no system region was exported. The entrypoint honors exported `EXT_MIGRATED_SYSTEM_*` memory, timeout, minimum/maximum instances, concurrency/CPU, VPC connector/egress, ingress, labels, and service-account options. Unspecified protobuf enum values are omitted as required by the migration guide. Runtime parameters are read at request time, so deployment discovery does not freeze environment-specific values. No secrets or lifecycle hooks are required. This API fetches publicly accessible images; it performs no authenticated bucket reads or writes and does not need the legacy extension's broad Storage Object Admin grant. Normal Cloud Functions/Cloud Run billing applies.

Deploy and verify the replacement in staging before changing App Hosting's `IMAGE_PROCESSING_FUNCTION_URL` secret to the new handler URL. The existing `/_fah/image/process` rewrite and web image loader remain compatible. Verify real URL input and transformed image dimensions, then update production and verify it too. Keep the old extension installed until traffic has switched successfully and the new handler has processed real requests.

Run `npm ci && npm test` in `source/` with Node.js 22. The tests use a local HTTP server and actual Sharp processing; they do not connect to development Firebase emulators.

## Behavior preserved and improvements

Both `/process?operations=...` and `/process/input~.../output~...` APIs and the full operation registry are retained. Inputs support public HTTPS URLs, configured-host relative paths, public GCS objects, and generated images. Composites now fetch their documented remote/GCS inputs instead of reading arbitrary local files. Text rendering loads only when used.

Malformed requests receive HTTP 400 through the corrected Express error handler. Query strings are decoded once, preserving percent characters in Storage filenames. Modern output encoding avoids the upstream redundant lossy re-encoding. The headers retain image content type and output metadata; mutable source URLs cache for one hour in browsers and one day in shared caches instead of one year.

Image input and output are limited to 20 MiB, source images to 40 million pixels, image dimensions to 16,384, and pipelines to 32 operations. Source fetches time out after 10 seconds, allow at most three redirects, and validate public DNS addresses on the actual connection to prevent private/metadata access. HTTPS is required except for an explicitly configured Storage emulator. Sharp processing has a 20-second timeout; the function has 1 GiB memory, concurrency 4, and at most 20 instances. Exported advanced system configuration takes precedence over the function defaults. These limits protect the public image endpoint from memory and CPU exhaustion. The CORS list is applied at request time; cross-origin image embedding remains supported.

The upstream's sequential operation materialization is retained because it defines the API's operation-order behavior. Changing it to a single Sharp pipeline can change repeated resize/crop/rotation semantics. A future optimization should preserve those contracts with representative image fixtures.
