#!/usr/bin/env python3
"""Read the staging uploader's current release and Email worker state."""

import argparse
import datetime
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

PROJECT = "urm-app-staging"
CONTROL = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/_control"
EMAIL_POOL = "urm-worker-email-0806960cd0d510ceabc4"
RUN = f"https://run.googleapis.com/v2/projects/{PROJECT}/locations/us-central1/workerPools/{EMAIL_POOL}"


def get_json(url, token):
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def document(url, token, *, optional=False):
    try:
        return get_json(url, token)
    except urllib.error.HTTPError as error:
        if optional and error.code == 404:
            return {}
        raise


def fields(value):
    return value.get("mapValue", {}).get("fields", {})


def field(record, name, value_type, default="unknown"):
    return record.get(name, {}).get(value_type, default)


def sample():
    token = subprocess.check_output(
        ["gcloud", "--quiet", "auth", "print-access-token"], stderr=subprocess.DEVNULL, text=True, timeout=15
    ).strip()
    control_doc = document(f"{CONTROL}/temporalRelease", token)
    state_doc = document(f"{CONTROL}/temporalReleaseState", token)
    operation_doc = document(f"{CONTROL}/temporalReleaseOperation", token, optional=True)
    control, state, operation = (doc.get("fields", {}) for doc in (control_doc, state_doc, operation_doc))
    pool = get_json(RUN, token)
    sampled = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    print(f"Observed {sampled} | {PROJECT}")
    print(
        f"Release revision {field(control, 'revision', 'integerValue')} | "
        f"admissions {field(control, 'admission', 'stringValue')} | "
        f"checkpoint {field(state, 'phase', 'stringValue')}"
    )
    if operation:
        action = field(operation, "action", "stringValue")
        print(f"Release operation {action} | last updated {operation_doc.get('updateTime', 'unknown')}")
        email = fields(operation.get("cloudEmailActivation", {}))
        if email:
            phase = field(email, "stage", "stringValue")
            stopped = field(email, "disposition", "stringValue")
            observation = fields(email.get("observation", {}))
            result = field(
                email, "retentionFailurePhase", "stringValue",
                field(observation, "failurePhase", "stringValue", "none recorded"),
            )
            print(f"Email activation {phase} | disposition {stopped} | failed check {result}")
            if phase == "completed" and stopped == "stopped":
                print("The held operation is terminal. Waiting alone cannot advance this checkpoint.")
    else:
        print("No release operation lock.")
    scaling = pool.get("scaling", {})
    print(
        f"Observed Email pool {EMAIL_POOL} | generation {pool.get('generation', 'unknown')} | "
        f"desired manual replicas {scaling.get('manualInstanceCount', 'not reported')} | "
        f"reconciling {pool.get('reconciling', False)}"
    )
    print(flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--watch", action="store_true", help="refresh every 30 seconds until interrupted")
    args = parser.parse_args()
    while True:
        try:
            sample()
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            reason = f"HTTP {error.code}" if isinstance(error, urllib.error.HTTPError) else type(error).__name__
            print(f"Staging read failed ({reason}). Check the active gcloud account and its read permissions.", file=sys.stderr)
            if not args.watch:
                return 1
        if not args.watch:
            return 0
        time.sleep(30)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
