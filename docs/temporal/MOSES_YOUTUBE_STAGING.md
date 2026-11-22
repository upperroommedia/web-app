# MosesTheStrong YouTube staging rollout

## Target

A normal staging uploader request for an eligible public YouTube video reaches MosesTheStrong, runs the existing native render pipeline, publishes the exact staging artifact generations through the original Temporal Workflow, and plays in Safari. Non-YouTube media stays on GCP. This rollout affects staging only. After the staging smoke passes, Moses becomes the default for eligible YouTube requests and Hetzner remains the named backup.

The desktop has already downloaded two public inputs without cookies. An isolated Temporal Workflow dispatched one of those downloads and an NVENC encode to the desktop. The desktop also reached the staging Temporal Cloud endpoint over verified TLS. These checks establish a working host and toolchain. The staging uploader still needs its native execution, storage, and release checks.

## 1. Preserve the execution authority

- Reuse the staging Cloud Run media Activity, original request and episode journal, render slot, parent/child startup and cancellation, and exact artifact receipt adoption. Keep Temporal task tokens on the existing authority path.
- Reuse the native render service on Moses. Expose only the staging render API and release health endpoint through an outbound connector, with a host-specific Google OIDC audience and the exact staging caller. Tailscale carries host administration. Keep other listeners loopback-only and leave existing home and production endpoints bound to their current owners.
- Use a separate fixed staging Moses hostname and a release-bound origin selection. Never take a target, audience, executable, credentials, or capacity from a request. Persist the host with each new episode. Original records imply Hetzner. Keep the host across retries, recovery, and status checks until native closure.
- Require one durable execution owner for each request. A lost response permits observation of the same operation. A new attempt or a host change requires authenticated close, positive drain, and an explicit new authorization. Select Hetzner for a new request if Moses fails its availability or readiness check before the request gets a host reservation. A lost start response or an offline host with an active reservation keeps the original owner. Automatic backup for an existing request is eligible only after verified native closure and positive drain authorize a new episode. A durable guest authentication challenge can append a Hetzner episode only when the original candidate and positive native close agree, the original slot is no longer held, and the same Temporal Activity rechecks the backup runtime pin. Both original and backup episodes remain in the job history.

## 2. Build and qualify the desktop

- Build the existing render image with staging provenance. Configure a dedicated unprivileged service identity, workspace, browser state location, and resource budgets. Use the approved staging-only credential mechanism with independently checked Firestore, Storage, and configuration scopes.
- Verify the pinned version of yt-dlp with its JS runtime, FFmpeg and ffprobe, available scratch and minimum headroom, callback connectivity, access policy, cleanup and process identity. Use guest extraction exclusively on Moses. The renderer ignores local yt-dlp configuration, browser profiles, cookie preferences, session refresh and browser fallback. Keep the PO-token provider optional for Moses. Videos requiring sign-in are outside the initial Moses capability.
- Treat GPU encoding as a video capability. Use the current audio codec and artifact contract for sermon audio. Do not switch codecs or consume GPU resources just because they are available.
- Verify a native service restart, unreachable home behavior, and host health without accepting new uploader work. Keep the existing staged roll-forward and production service available while the new endpoint is being tested.

## 3. Integrate and deploy

- Add host-bound episode validation, shared fixed origins and matching audience, signed activation/readback for the selected staged host, and an explicit staged routing selection. Run unit and emulator proof for older records, target separation, tampered audiences, retries, lost acknowledgement, and original-owner cancellation. Replay protected histories against the exact candidate image.
- Verify the exact staging source, image and deployment receipts. The existing staged release must settle its held operations and preserve its original provider epoch before a successor can own the next cutover. Deploy the Moses endpoint in verification mode and collect live environment, buffer, process and artifact readback. Enable the selector only after paused-admission, drained-writer, and release custody checks succeed.
- First admit a single deliberately named public staging upload with a known test video. Repeat with a different owned input and exercise cancellation during native work and reconciliation after lost acknowledgement. Verify the native process identity, source/processed/final object generations, completion and no duplicate execution, audio playback and seek, and state after reload in Safari.
- Confirm direct uploads still route through GCP and staging providers remain sandboxed. Test a fresh request while Moses is unavailable and verify it routes once through Hetzner. Separately interrupt a Moses request after it takes ownership and verify Hetzner receives no duplicate work while the original outcome is uncertain. After the smoke passes, select Moses as the staging default for eligible public YouTube jobs and verify the visible upload flow a final time.

## 4. Rollback and handoff

Pause new YouTube admissions if the desktop, route, or required attestation is unavailable. Observe and close known home executions under their original authorization. Roll back routing for new requests only after the existing release guard proves drain and records the rollback. Keep completed artifacts and held requests intact. The staging URL and exact tested behavior are reported only after the real uploader smoke passes.

## 5. Evaluate the backup over two months

Measure Moses availability, YouTube success and retry rates, end-to-end processing time, backlog, and every Hetzner fallback. Exercise host reboot, reconnect, and lease recovery during the trial. Review any fallback for traffic or formats Moses cannot serve, including public guest and authenticated paths if used.

After roughly two months of stable operation, review the evidence before scheduling retirement. Retire Hetzner only after its active reservations, native processes, and pending recovery work are drained and its rollback role is no longer needed. Handle any production routing or infrastructure change under a separate reviewed rollout.

## Verification checkpoint

- Key-only SSH succeeds against the pinned MosesTheStrong host key. The staging connector is enabled as a user service and Cloudflare reports four connections. Its ingress accepts only the staging health and render paths. The public hostname has yet to be published.
- The render image builds natively for Linux amd64 with the Moses-only yt-dlp 2026.10.26 pin. A network-isolated test on Moses confirms the unprivileged UID, exact downloader, verify-mode health and refusal of acquisition, render, authentication, and activation probes.
- The updated production downloader ran on Moses against a public Upper Room Media video, using no cookies, Firebase calls or PO-token provider. It produced 2,841,272 bytes of playable audio with a duration of about 176 seconds. The same image reported guest-only mode and rejected both read and start requests to the authentication endpoint in an isolated test. The staging candidate has yet to be deployed.
- The new worker selection uses bounded fresh health challenges at the two fixed origins. It verifies the pinned staging release and runtime for each host before a new job chooses it. Existing episodes keep their original target. A changed runtime after restart needs new activation evidence before it can receive work under a pinned release.
- The remaining native work is to qualify a dedicated staging renderer identity, seal and publish its guarded release, resolve the existing paused release, and complete the Safari uploader and failover tests. The staging admission record independently read at revision 85 is paused for media and every other domain.

## Monitor staging

Run `python3 scripts/watch-staging-uploader.py --watch` in the Codex integrated terminal or a normal terminal from this worktree. It checks the staging admission revision, release checkpoint, held operation, and the Email worker pool involved in this handoff every 30 seconds through the active gcloud account. Omit `--watch` for one read. Use Ctrl+C to close the monitor. A terminal stopped receipt means the held operation has ended and the release needs a new guarded step.

Use `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes asaad nvidia-smi -l 2` in another terminal to see Moses GPU utilization and memory. The current audio renderer uses FFmpeg software audio filters and MP3 encoding. It contains no transcription step or video encoding stage. Video hardware acceleration and GPU transcription have separate activation requirements from the uploader release.

## GPU qualification on MosesTheStrong

- Native FFmpeg encoded a 1080p test clip using `h264_nvenc`. The output passed ffprobe. This verifies the desktop video encoder.
- An isolated faster-whisper test transcribed an 11-second public speech sample using CUDA FP16. It checked the transcript, confirmed the actual inference device and saw the same process hold 330 MiB of GPU memory. The test used a temporary environment and did not create an uploader activity.
- Docker rejected GPU device discovery for the actual renderer image. Activate a GPU-capable container runtime and verify GPU access inside the exact release image before giving containerized transcription or video encoding work to Moses. The current audio-only uploader continues to use its existing software processing.

## Local renderer verification

The host launcher lives in `ops/process-audio-moses-staging/renderer.py`. Keep `inspect-renderer.cjs` beside it. The launcher uses Linux, Python 3, OpenSSL 3, findmnt and the local Docker Engine. Each invocation starts or observes exactly one signed operation. The CPU-only container runs as 1000:1000 with a read-only root, 4 CPUs, 8 GiB memory, 256 PIDs, and one FFmpeg/download slot. It receives a disk-backed private directory at `/tmp`. Both the host and the container measure that directory and match its device and inode. The required available space is 64 GiB plus 16 GiB headroom. The public guest renderer uses the native image's yt-dlp 2026.10.26, Deno 2.9.5 and FFmpeg/ffprobe 8.1.

**Offline rehearsal.** Choose a private operator-owned directory on a local disk. Create a child named `scratch` owned by UID 1000; both directories require mode 0700. Set `umask 077`. Place an Ed25519 PEM public key at `operator.pub` and a signed UTF-8 `release.json` with this shape. Replace the illustrative UUIDs, commit and image ID with the actual release, fresh operation and build evidence. `imageId` is the full local Docker image configuration digest.

```json
{
  "kind": "urm.moses.staging.renderer.v1",
  "role": "isolated-verification",
  "target": "moses",
  "mode": "verify",
  "releaseId": "11111111-1111-4111-8111-111111111111",
  "operationId": "22222222-2222-4222-8222-222222222222",
  "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "imageId": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

On the signer, use `openssl pkeyutl -sign -inkey operator-private.pem -rawin -in release.json -out release.sig`. Transfer the signature and manifest to the host, with mode 0600 on both and on the public key. Keep private signing keys off the credentialed renderer. Rehearsal uses its own operator key. From the reviewed scripts directory, run:

```sh
python3 renderer.py isolate --isolated-dir "$rehearsal_dir"
python3 renderer.py observe --isolated-dir "$rehearsal_dir"
```

Rehearsal uses Docker's `none` network and mounts only scratch. The validator contacts HTTP inside the container, confirms the expected toolchain and guest settings and exercises the verify-mode refusal of acquisition, render, authentication and release challenges. The returned SHA-256 identifies the immutable operation receipt in `audit/<operationId>.receipt.json`.

**Credentialed user service on MosesTheStrong.** The dedicated staging service account and file-based workload identity provider have been provisioned. The native host exchanged a subject token with Google STS, impersonated the staging account, read the Firestore release control and checked a missing Storage object. A signed verify run repeats those reads inside the actual staging container.

The local Docker operator on MosesTheStrong has UID and GID 1000. Use that account to create each of these directories with mode 0700. The launcher derives the account home from the host account database.

| Directory                                            | Contents                                                                                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.local/share/urm-youtube-moses-staging/renderer/` | Reviewed `renderer.py`, `inspect-renderer.cjs` and separately provisioned `signer-pins.json`                                                                                                                |
| `~/.config/urm-youtube-moses-staging/`               | Existing connector configuration plus renderer `release.json`, `release.sig`, `operator.pub`, `adc.json` and `sentry-dsn`. Guarded activation also uses `activation.json`, `activation.sig` and `guard.pub` |
| `~/.config/urm-youtube-moses-staging/federation/`    | One atomically renewed `subject.jwt` for Moses. The separate issuer key stays in `federation-bootstrap/` on the host                                                                                        |
| `~/.local/state/urm-youtube-moses-staging/`          | Private `scratch/` on the reviewed local filesystem and write-once operation records in `audit/`                                                                                                            |

Install the two scripts as ordinary files owned by the operator. Set mode 0400 or 0600 on the pin file, manifests, signatures, public keys, ADC and DSN. The configured public keys use Ed25519 PEM. The pin file contains independent SHA-256 fingerprints of the operator and guard public keys, in the shape `{"operator":"<64 lowercase hex>","guard":"<different 64 lowercase hex>"}`. Obtain these fingerprints through the trusted release authority. Compute a supplied public key's fingerprint with `openssl pkey -pubin -in operator.pub -outform DER | sha256sum`. Compare against the separately provisioned value before installing the key. The host needs only the guard fingerprint during verification.

Install the reviewed `staging-adc.json` as `adc.json`, owned by UID/GID 1000. Its Google STS audience is `//iam.googleapis.com/projects/251680231116/locations/global/workloadIdentityPools/urm-moses-staging/providers/moses` and its impersonated account is `process-audio-moses@urm-app-staging.iam.gserviceaccount.com`. The issuer writes `subject.jwt` as mode 0640 within the private 0700 directory. The launcher checks its issuer, subject, audience, RS256 profile and five-minute lifetime. Google STS checks its signature. The container mounts only that token directory and ADC read-only, along with the writable scratch directory. The staging Sentry DSN is provided separately. The offline rehearsal continues to use Docker's `none` network.

Sign a new manifest with role `staging-renderer`, mode `verify`, and the independently established staging release, commit and immutable image. Install `urm-youtube-moses-renderer@.service` in `~/.config/systemd/user/`. To run the verification and later observe that exact container:

```sh
systemctl --user daemon-reload
systemctl --user start urm-youtube-moses-renderer@verify.service
journalctl --user -u urm-youtube-moses-renderer@verify.service -n 12 --no-pager
systemctl --user start urm-youtube-moses-renderer@observe.service
```

The user unit runs the operator once per explicit invocation. Docker Engine 28 or newer publishes `127.0.0.1:18082` for the existing connector. The verifier reads staging Firestore and checks the absence of a fresh staging workflow-audio object from the exact container. A successful unit reports the operation, role, boot identity where applicable and stable receipt SHA-256. The unit exits after the check. Docker retains the original container with restart policy `no`. A repeated observation checks that container's start time, boot identity and scratch inode against its receipt. Requester-auth lookup, artifact publication, public ingress and playback have separate end-to-end rollout checks.

**Root installation.** The existing root-operated configuration remains available through `python3 renderer.py verify` and `python3 renderer.py observe`. Root owns reviewed scripts, configuration at `/etc/urm-youtube-moses-staging`, and state at `/var/lib/urm-youtube-moses-staging`. Both directories require mode 0700. The `scratch` directory is UID/GID 1000 mode 0700. ADC is root:1000 mode 0440. The root token directory uses root:1000 mode 0750 and its JWT uses root:1000 mode 0440 or 0640. The root profile also supports the dedicated staging service-account ADC. The UID 1000 service requires file-based federation.

**Guarded activation.** Activation consumes a second staging manifest with mode `enabled` for the same release, image and commit and a new operation UUID. The release authority independently checks paused admission, positive drain, release custody, caller bindings and the reviewed candidate. Only that authority can issue the short-lived Ed25519 certificate. Pin its public key as `guard.pub` independently from `operator.pub`. The release operator's `prepare-staging-moses-activation` records a one-time grant under the paused checkpoint and a free native render slot. Pass the authenticated SSH-exported verification receipt as `--moses-verification-receipt`, the owned guard key as `--moses-guard-key`, and fresh private output paths as `--moses-guard-payload` and `--moses-guard-signature`. Publish the host's native activation receipt with `record-staging-moses-activation --moses-native-receipt <path>` under the original release. The operator joins both signatures, the native start, the grant, and the live fixed-origin challenge before it can record the immutable receipt. The raw UTF-8 `activation.json` is signed to `activation.sig` with the same OpenSSL command and file modes. Its fields are:

| Field                                   | Required value                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| kind                                    | `urm.moses.staging.activation.v1`                                                                                  |
| manifestSHA256                          | SHA-256 of the exact signed enabled manifest bytes                                                                 |
| releaseId, operationId                  | UUIDs from that manifest                                                                                           |
| verifiedOperationId, verificationSHA256 | Original credentialed staging verification operation in the same host installation and SHA-256 of its receipt file |
| controlRevision                         | Positive staging control revision checked by the release authority                                                 |
| issuedAt, expiresAt                     | Integer Unix seconds, valid now, at most 300 seconds apart                                                         |

After the verification container has been explicitly stopped, retain it so the operator can inspect its immutable ID and original start time. Under the approved release operation, the user installation runs `systemctl --user start urm-youtube-moses-renderer@activate.service`. The root installation runs `python3 renderer.py activate`. The launcher checks the guard before creating and starting the container. The activated runtime produces a fresh challenge and its own runtime UUID. Its receipt includes that UUID, image ID, native container ID, scratch identity, credential type/principal, signed manifests and role. The worker selector must bind its own independently verified release to this exact runtime before admission. On a failed or uncertain start, recover the original operation with `observe`. Docker restart policy is `no`. A stopped container, a changed process identity, a nonempty scratch directory or missing close evidence requires reconciliation with the original journal. The host launcher has no restart, cleanup, routing or admission operation.
