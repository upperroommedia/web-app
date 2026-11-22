#!/usr/bin/env python3
"""Issue a short-lived subject credential for the dedicated Moses staging provider."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time

ISSUER = "https://yt-moses-staging.upperroommedia.org/identity"
AUDIENCE = "https://iam.googleapis.com/projects/251680231116/locations/global/workloadIdentityPools/urm-moses-staging/providers/moses"
SUBJECT = "moses-staging-renderer"
OPENSSL = "/usr/bin/openssl"


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def openssl(*args, data=None):
    return subprocess.run([OPENSSL, *args], input=data, capture_output=True, check=True, timeout=10).stdout


def public_key(key):
    metadata = key.lstat()
    if key != key.resolve() or not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or (
        metadata.st_mode & 0o777
    ) != 0o600 or metadata.st_nlink != 1:
        raise ValueError("The signing key must be a private, owned regular file")
    der = openssl("pkey", "-in", str(key), "-pubout", "-outform", "DER")
    raw = openssl("rsa", "-in", str(key), "-modulus", "-noout").strip().decode("ascii")
    modulus = bytes.fromhex(raw.removeprefix("Modulus="))
    if int.from_bytes(modulus, "big").bit_length() != 3072:
        raise ValueError("Expected the dedicated RSA-3072 signing key")
    return {"kty": "RSA", "alg": "RS256", "use": "sig", "kid": b64(hashlib.sha256(der).digest()),
            "n": b64(modulus), "e": "AQAB"}


def token(key):
    public = public_key(key)
    now = int(time.time())
    segments = (
        {"typ": "JWT", "alg": "RS256", "kid": public["kid"]},
        {"iss": ISSUER, "sub": SUBJECT, "aud": AUDIENCE, "iat": now, "exp": now + 300},
    )
    signing_input = ".".join(b64(json.dumps(value, separators=(",", ":")).encode("utf-8")) for value in segments)
    signature = openssl("dgst", "-sha256", "-sign", str(key), data=signing_input.encode("ascii"))
    return signing_input + "." + b64(signature)


def publish(key, directory):
    directory_owner = directory.lstat()
    if directory != directory.resolve() or not stat.S_ISDIR(directory_owner.st_mode) or (
        directory_owner.st_uid != os.geteuid() or (directory_owner.st_mode & 0o777) not in (0o700, 0o750)
    ):
        raise ValueError("Expected an owned private token directory")
    fd, temporary = tempfile.mkstemp(prefix=".moses-subject-", dir=directory.parent)
    try:
        with os.fdopen(fd, "w", encoding="ascii") as stream:
            os.fchmod(stream.fileno(), 0o640)
            if os.geteuid() == 0:
                os.fchown(stream.fileno(), 0, directory_owner.st_gid)
            stream.write(token(key))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, directory / "subject.jwt")
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("mode", choices=("jwks", "refresh"))
    cli.add_argument("--key", type=Path, required=True)
    cli.add_argument("--token-dir", type=Path)
    args = cli.parse_args()
    if args.mode == "jwks" and args.token_dir is None:
        print(json.dumps({"keys": [public_key(args.key)]}))
    elif args.mode == "refresh" and args.token_dir is not None:
        publish(args.key, args.token_dir)
    else:
        cli.error("Supply token-dir for refresh only")


if __name__ == "__main__":
    main()
