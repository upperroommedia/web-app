# Testing provider publishing on staging

The signed-in app asks the server which publishing profile is active. The staging simulation notice appears only after the server validates both the staging profile and its imported catalog. Uploads, Storage, audio processing and Temporal remain real staging services. Subsplash and SoundCloud use the simulated account. The browser cannot switch staging to a real provider account.

If the server cannot verify the profile or catalog, publishing and account connection controls are paused. Use **Check again** after the configuration or import is repaired. Existing production-linked catalog identities need an explicit matching simulation import; a missing resource is a conflict, never permission to contact production.

Administrators can choose a scenario in the sermon publishing panel: successful request, slow processing, temporary failure, permanent failure or confirmation lost after saving. The choice applies to the next publish, advanced publish or unpublish request. The server validates it and records the profile and scenario on the durable task. **Check submitted request** resubmits the original uncertain intent. Retrying an accepted task keeps its original scenario; it does not apply the selector's current value.

In Advanced settings, **Connect simulated account** opens the same-origin staging consent page and returns through the normal SoundCloud callback and PKCE exchange. No real SoundCloud login is needed. A failed or uncertain consent must be restarted from Advanced settings rather than repeatedly issuing new codes.

## Smoke checklist

1. Sign in as an admin and confirm the simulation notice. Sign in as a non-admin publisher and confirm the scenario selector is absent.
2. Use a newly owned test sermon with imported staging list/series identities. Upload and process real staging audio; confirm durable progress survives reload.
3. Connect the simulated SoundCloud account from Advanced settings. Confirm the consent and callback remain on the staging origin.
4. Publish with success. Check each provider's confirmed result, simulated task label and recorded profile. Open **Inspect simulated destinations** from the task. Check the saved virtual resource IDs and request outcomes; a green task badge alone is insufficient.
5. On separate owned tests, exercise slow processing, temporary and permanent failure. Confirm attempts, retry times and attention states follow actual durable task updates.
6. Exercise confirmation lost after saving. Inspect provider reconciliation and the recorded resource count to detect duplicates. Do not infer success solely from the admission response.
7. Unpublish an owned simulated publication. Check destination results and task history. Retry retains the original scenario.
8. Disconnect/reconnect the browser and reload mid-task. Stale controls must remain disabled; recovery must observe the same task.
9. Verify production has no simulation notice or scenario controls, and the server rejects simulation fields there. This requires backend tests; do not publish a production smoke test.

The UI does not create provider completion receipts, seed missing resources or override uncertain destination outcomes. Readiness, transport isolation and imported catalog correctness remain server responsibilities.

Password-reset emails are unavailable in the app for the configured staging project, including before sign-in. Use dedicated test identities or contact an administrator. This is an app restriction; it does not claim that Firebase Authentication itself has been replaced with a simulator.

## Inspecting a lost response

An administrator can open **Inspect simulated destinations** on a server-stamped simulated task. The read-only page shows up to 100 request summaries and 200 journal-linked virtual resources. It deliberately exposes no raw provider request paths, tokens, URLs, Storage objects or resource bodies. It does not promise a complete or latest-first history; an incomplete view displays a warning. A reported ready time is metadata, not confirmation that processing finished.

The callable checks the administrator's current account, the current server profile/catalog, and the task's immutable intent/job pins, including completed historical tasks. Copy a resource ID manually into the existing review workflow only after checking the destination evidence. Viewing or refreshing the inspector never approves a receipt, changes a destination, retries work or completes a task.

Email tasks show **Email captured for staging** only after a successful task contains complete server capture provenance for the staging mail profile, including capture and payload fingerprints and an explicit no-external-delivery marker. A task with only the capture profile says external delivery is disabled and capture is unconfirmed. The publishing-mode banner makes no claim that mail capture is available. Captured message content remains private.
