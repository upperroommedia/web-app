# Phase 04: User Setup Required

**Generated:** 2026-03-01
**Phase:** 04-role-based-invite-onboarding-and-operational-notification-routing
**Status:** Incomplete

Complete these items for notification delivery to function in Firebase environments.

## Environment Variables

| Status | Variable | Source | Add to |
|--------|----------|--------|--------|
| [ ] | `ROLE_REQUEST_RECIPIENTS` | Firebase Functions params (`firebase functions:params:set`) | Firebase Functions runtime params |
| [ ] | `RUNTIME_ALERT_RECIPIENTS` | Firebase Functions params (`firebase functions:params:set`) | Firebase Functions runtime params |
| [ ] | `ADMIN_BASE_URL` | Production admin URL (for notification links) | Firebase Functions runtime params |

## Dashboard Configuration

- [ ] **Install and configure Trigger Email extension**
  - Location: Firebase Console -> Extensions -> Trigger Email (`firebase/firestore-send-email`)
  - Set to: Use Firestore collection `mail` for outbound queue processing
  - Notes: This plan writes queue documents only; extension transport must exist per project/environment.

## Verification

After completing setup, verify with:

```bash
cd functions
firebase ext:list --project <project-id>
firebase functions:params:get --project <project-id>
```

Expected results:
- Trigger Email extension appears as installed for the target project.
- Params output includes `ROLE_REQUEST_RECIPIENTS`, `RUNTIME_ALERT_RECIPIENTS`, and `ADMIN_BASE_URL`.

---

**Once all items complete:** Mark status as "Complete" at top of file.
