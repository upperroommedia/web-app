#!/usr/bin/env python3
"""Local Linux operator for the Moses staging renderer. No network control API."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import time
import tempfile

PROJECT = 'urm-app-staging'
ACCOUNT = 'process-audio-moses@urm-app-staging.iam.gserviceaccount.com'
AUDIENCE = '//iam.googleapis.com/projects/251680231116/locations/global/workloadIdentityPools/urm-moses-staging/providers/moses'
CONFIG = Path('/etc/urm-youtube-moses-staging')
STATE = Path('/var/lib/urm-youtube-moses-staging')
INSPECT = Path(__file__).resolve().with_name('inspect-renderer.cjs')
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
DOCKER = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
GIB = 1024 ** 3


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(command, **options):
    return subprocess.run(command, capture_output=True, check=True, timeout=20,
                          env={'PATH': '/usr/local/bin:/usr/bin:/bin', **options.pop('env', {})},
                          **options).stdout


def protected(path, owner, directory=False, modes=(0o400, 0o600), group=None):
    s = path.lstat()
    require(path == path.resolve() and s.st_uid == owner, f'Unexpected owner or symlink at {path}')
    if directory:
        require(stat.S_ISDIR(s.st_mode) and s.st_mode & 0o777 == 0o700, f'Expected a private directory at {path}')
    else:
        require(stat.S_ISREG(s.st_mode) and s.st_mode & 0o777 in modes and s.st_nlink == 1 and 0 < s.st_size <= 16384,
                f'Expected a small protected file at {path}')
        if group is not None:
            require(s.st_gid == group, f'Unexpected group at {path}')
    return s


def document(raw):
    def fields(pairs):
        obj = dict(pairs)
        require(len(obj) == len(pairs), 'Duplicate JSON field')
        return obj
    value = json.loads(raw, object_pairs_hook=fields)
    require(isinstance(value, dict), 'Expected JSON object')
    return value


def signed(config, name, signer, owner):
    payload, signature, key = (config / (name + '.json'), config / (name + '.sig'), config / (signer + '.pub'))
    for path in (payload, signature, key):
        protected(path, owner)
    raw, sig, public = payload.read_bytes(), signature.read_bytes(), key.read_bytes()
    key_der = run(['/usr/bin/openssl', 'pkey', '-pubin', '-outform', 'DER'], input=public)
    require(len(key_der) == 44 and key_der[:12] == bytes.fromhex('302a300506032b6570032100'), 'Expected Ed25519 key')
    require(len(sig) == 64, 'Expected Ed25519 signature')
    # OpenSSL Ed25519 needs seekable input. Verify the exact bytes kept in the journal.
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp)
        for name, data in [('message', raw), ('signature', sig), ('public', public)]:
            (copy / name).write_bytes(data)
        run(['/usr/bin/openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', copy / 'public', '-rawin',
             '-in', copy / 'message', '-sigfile', copy / 'signature'])
    return document(raw), digest(raw), digest(key_der), {'payload': raw.decode(), 'signature': sig.hex(), 'publicKey': public.decode()}


def check_release(value, role):
    require(set(value) == {'kind', 'role', 'target', 'mode', 'commit', 'imageId', 'releaseId', 'operationId'}
            and value['kind'] == 'urm.moses.staging.renderer.v1' and value['role'] == role and value['target'] == 'moses'
            and value['mode'] in ('verify', 'enabled') and (role == 'staging-renderer' or value['mode'] == 'verify')
            and re.fullmatch(r'[a-f0-9]{40}', value['commit']) and re.fullmatch(r'sha256:[a-f0-9]{64}', value['imageId'])
            and all(re.fullmatch(UUID, value[key]) for key in ('releaseId', 'operationId')), 'Unexpected release manifest')


def check_subject(token):
    encoded = token.read_bytes()
    require(re.fullmatch(rb'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', encoded), 'Expected staging subject JWT')
    header, body, signature = (base64.urlsafe_b64decode(part + b'=' * (-len(part) % 4)) for part in encoded.split(b'.'))
    meta, claims = document(header), document(body)
    now = int(time.time())
    require(meta.get('alg') == 'RS256' and meta.get('typ') == 'JWT' and len(signature) == 384 and
            claims.get('iss') == 'https://yt-moses-staging.upperroommedia.org/identity' and
            claims.get('sub') == 'moses-staging-renderer' and claims.get('aud') == AUDIENCE.replace('//', 'https://', 1)
            and type(claims.get('iat')) is int and type(claims.get('exp')) is int and
            claims['iat'] <= now < claims['exp'] <= claims['iat'] + 300, 'Expected fresh staging renderer subject')
    # The running ADC exchanges this subject with the fixed Google STS provider, which verifies its signature.


def signer_pins(directory, owner):
    file = directory / 'signer-pins.json'
    protected(file, owner)
    pins = document(file.read_bytes())
    require(set(pins) == {'operator', 'guard'} and pins['operator'] != pins['guard'] and
            all(isinstance(key, str) and re.fullmatch(r'[0-9a-f]{64}', key) for key in pins.values()),
            'Expected two independently pinned signing identities')
    return pins


def adc_mounts(config, owner):
    adc = config / 'adc.json'
    user_service = owner != 0
    protected(adc, owner, modes=(0o400, 0o600) if user_service else (0o440,), group=1000)
    value = document(adc.read_bytes())
    mounts = [(adc, '/run/urm-adc.json')]
    if not user_service and value.get('type') == 'service_account':
        require(value.get('project_id') == PROJECT and value.get('client_email') == ACCOUNT
                and value.get('token_uri') == 'https://oauth2.googleapis.com/token'
                and value.get('universe_domain', 'googleapis.com') == 'googleapis.com'
                and re.fullmatch(r'[0-9a-f]{40}', value.get('private_key_id', ''))
                and value.get('private_key', '').startswith('-----BEGIN PRIVATE KEY-----'),
                'Expected the dedicated staging service account')
    else:
        impersonate = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + ACCOUNT + ':generateAccessToken'
        allowed = {'type', 'audience', 'subject_token_type', 'token_url', 'service_account_impersonation_url',
                   'credential_source', 'universe_domain'}
        require(set(value) <= allowed and value.get('type') == 'external_account' and value.get('audience') == AUDIENCE
                and value.get('subject_token_type') == 'urn:ietf:params:oauth:token-type:jwt'
                and value.get('token_url') == 'https://sts.googleapis.com/v1/token'
                and value.get('service_account_impersonation_url') == impersonate
                and value.get('universe_domain', 'googleapis.com') == 'googleapis.com'
                and value.get('credential_source') in ({'file': '/run/urm-identity/subject.jwt'},
                   {'file': '/run/urm-identity/subject.jwt', 'format': {'type': 'text'}}),
                'Expected staging file-based identity federation')
        tokens = config / 'federation'
        s = tokens.lstat()
        token = tokens / 'subject.jwt'
        require(tokens == tokens.resolve() and stat.S_ISDIR(s.st_mode) and s.st_uid == owner and s.st_gid == 1000
                and s.st_mode & 0o777 == (0o700 if user_service else 0o750) and list(tokens.iterdir()) == [token],
                'Expected a dedicated token directory')
        protected(token, owner, modes=(0o400, 0o600, 0o640) if user_service else (0o440, 0o640), group=1000)
        check_subject(token)
        mounts.append((tokens, '/run/urm-identity'))
    return value['type'], mounts


def check_scratch(scratch, empty):
    s = protected(scratch, 1000, directory=True)
    require(not empty or not any(scratch.iterdir()), 'Original scratch contains data; reconcile its owner before launch')
    fs = run(['/usr/bin/findmnt', '-nro', 'FSTYPE', '-T', scratch]).decode().strip()
    block = Path('/sys/dev/block') / f'{os.major(s.st_dev)}:{os.minor(s.st_dev)}'
    require(fs in ('ext4', 'xfs', 'btrfs') and block.exists(), 'Scratch must be a local disk-backed filesystem')
    disk = os.statvfs(scratch)
    require(disk.f_bavail * disk.f_frsize >= 80 * GIB, 'Scratch requires 64 GiB workspace plus 16 GiB headroom')
    return s


def check_image(image):
    info = json.loads(run(DOCKER + ['image', 'inspect', image]))[0]
    require(info['Id'] == image and info['Os'] == 'linux' and info['Architecture'] == 'amd64', 'Unexpected image identity')
    config = info['Config']
    image_env = dict(field.split('=', 1) for field in config['Env'])
    allowed = {'PATH', 'NODE_VERSION', 'YARN_VERSION', 'NODE_ENV', 'PROCESS_AUDIO_RUNTIME_PROFILE',
               'PROCESS_AUDIO_YT_DLP_VERSION', 'PROCESS_AUDIO_FFMPEG_VERSION'}
    require(set(image_env) <= allowed and image_env.get('PROCESS_AUDIO_RUNTIME_PROFILE') == 'hetzner'
            and image_env.get('PROCESS_AUDIO_YT_DLP_VERSION') == '2026.10.26'
            and image_env.get('PROCESS_AUDIO_FFMPEG_VERSION') == '8.1' and not config.get('Volumes'),
            'Unexpected image runtime contract')


def create(value, release_sha, scratch, mounts, dsn):
    isolated = value['role'] == 'isolated-verification'
    name = 'urm-moses-' + ('isolated-' if isolated else 'staging-') + value['operationId']
    cmd = DOCKER + ['create', '--name', name, '--pull=never', '--restart=no', '--runtime=runc', '--init',
                    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000',
                    '--cpus=4', '--memory=8g', '--memory-swap=8g', '--pids-limit=256', '--no-healthcheck',
                    '--log-opt=max-size=10m', '--log-opt=max-file=3', '--label', 'urm.moses.release-sha256=' + release_sha,
                    '--entrypoint=/usr/local/bin/node', '--workdir=/workspace/apps/process-audio']
    cmd += ['--network=none'] if isolated else ['--network=bridge', '--publish=127.0.0.1:18082:8080/tcp']
    cmd += ['--mount', f'type=bind,src={scratch},dst=/tmp']
    for path, target in mounts:
        cmd += ['--mount', f'type=bind,src={path},dst={target},readonly']
    env = {
        'PORT': '8080', 'NODE_ENV': 'production', 'TMPDIR': '/tmp', 'HOME': '/tmp', 'YTDLP_JS_RUNTIME': 'deno',
        'FIREBASE_PROJECT_ID': PROJECT, 'GOOGLE_CLOUD_PROJECT': PROJECT, 'FIREBASE_STORAGE_BUCKET': PROJECT + '.firebasestorage.app',
        'FIREBASE_DATABASE_URL': 'https://urm-app-staging-default-rtdb.firebaseio.com/', 'PROCESS_AUDIO_RUNTIME_ENV': 'staging',
        'PROCESS_AUDIO_RUNTIME_HOST': 'moses', 'PROCESS_AUDIO_TEMPORAL_YOUTUBE_RENDER_TARGET': 'moses',
        'PROCESS_AUDIO_TEMPORAL_YOUTUBE_RENDER': value['mode'], 'YOUTUBE_BROWSER_FALLBACK_ENABLED': 'false',
        'YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS': 'false', 'PROCESS_AUDIO_FFMPEG_CONCURRENCY': '1',
        'PROCESS_AUDIO_YTDLP_DOWNLOAD_CONCURRENCY': '1', 'TEMPORAL_MEDIA_MAX_SOURCE_BYTES': str(20 * GIB),
        'TEMPORAL_MEDIA_MAX_OUTPUT_BYTES': str(20 * GIB), 'TEMPORAL_MEDIA_WORKSPACE_MAX_BYTES': str(64 * GIB),
        'TEMPORAL_MEDIA_DISK_HEADROOM_BYTES': str(16 * GIB), 'SENTRY_ENVIRONMENT': 'staging',
        'SENTRY_RELEASE': 'process-audio-hetzner@staging-' + value['commit'],
    }
    if not isolated:
        env['GOOGLE_APPLICATION_CREDENTIALS'] = '/run/urm-adc.json'
        cmd += ['--env', 'SENTRY_DSN']
    for key, setting in env.items():
        cmd += ['--env', key + '=' + setting]
    return run(cmd + [value['imageId'], './dist/index.js'], env={'SENTRY_DSN': dsn}).decode().strip()


def container_info(cid):
    require(re.fullmatch(r'[0-9a-f]{64}', cid), 'Expected original Docker container ID')
    return json.loads(run(DOCKER + ['inspect', '--type', 'container', cid]))[0]


def check_container(info, value, release_sha, cid, scratch, mounts):
    isolated = value['role'] == 'isolated-verification'
    expected = {('/tmp', str(scratch), True), *((target, str(source), False) for source, target in mounts)}
    actual = {(m['Destination'], m.get('Source'), m['RW']) for m in info['Mounts'] if m['Type'] == 'bind'}
    host, cfg = info['HostConfig'], info['Config']
    publish = {} if isolated else {'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18082'}]}
    require(info['Id'] == cid and info['Image'] == value['imageId'] and cfg['Labels'].get('urm.moses.release-sha256') == release_sha
            and cfg['User'] == '1000:1000' and cfg['Entrypoint'] == ['/usr/local/bin/node'] and cfg['Cmd'] == ['./dist/index.js']
            and len(info['Mounts']) == len(expected) and actual == expected
            and host['ReadonlyRootfs'] and not host['Privileged'] and host['CapDrop'] == ['ALL'] and not host['CapAdd']
            and any(item in ('no-new-privileges', 'no-new-privileges:true', 'no-new-privileges=true') for item in (host['SecurityOpt'] or []))
            and not host['Devices'] and not host['DeviceRequests']
            and host['Runtime'] == 'runc' and host['RestartPolicy']['Name'] == 'no'
            and host['NetworkMode'] == ('none' if isolated else 'bridge') and (host['PortBindings'] or {}) == publish
            and host['NanoCpus'] == 4_000_000_000 and host['Memory'] == 8 * GIB and host['MemorySwap'] == 8 * GIB
            and host['PidsLimit'] == 256, 'Native container isolation does not match the reviewed staging role')


def native(value, release_sha, cid, scratch, mounts):
    info = container_info(cid)
    started = info['State']['StartedAt']
    check_container(info, value, release_sha, cid, scratch, mounts)
    require(info['State']['Running'] and info['RestartCount'] == 0, 'Container identity changed')
    wait_for_health = ("fetch('http://127.0.0.1:8080/healthz', {signal:AbortSignal.timeout(2000)})"
                       ".then(r=>process.exit(r.ok?0:1),()=>process.exit(1))")
    deadline = time.monotonic() + 35
    while True:
        try:
            run(DOCKER + ['exec', cid, 'node', '-e', wait_for_health])
            break
        except subprocess.CalledProcessError:
            require(time.monotonic() < deadline, 'Original container health endpoint unavailable')
            time.sleep(0.5)
    try:
        raw = run(DOCKER + ['exec', '-i', cid, 'node', '-', value['role'], value['mode'], value['commit']], input=INSPECT.read_bytes())
    except subprocess.CalledProcessError as error:
        # The inspector emits its failing assertion or native version, never ADC material.
        raise ValueError('Original container inspection failed: ' + error.stderr.decode(errors='replace')[:350]) from error
    observed = document(raw)
    s = check_scratch(scratch, False)
    require((observed.get('device'), observed.get('inode')) == (str(s.st_dev), str(s.st_ino)),
            'Native tmpdir differs from the inspected host scratch')
    after = container_info(cid)
    require(after['State']['Running'] and after['State']['StartedAt'] == started and after['RestartCount'] == 0,
            'Container restarted during observation')
    return {'startedAt': started, 'containerId': cid, **observed}


def save_once(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def activation_guard(config, audit, value, release_sha, operator_key, owner, pins):
    guard, guard_sha, guard_key, signed_guard = signed(config, 'activation', 'guard', owner)
    now = int(time.time())
    require((pins is None or guard_key == pins['guard']) and guard_key != operator_key and set(guard) == {'kind', 'manifestSHA256', 'releaseId', 'operationId',
            'verifiedOperationId', 'verificationSHA256', 'controlRevision', 'issuedAt', 'expiresAt'}
            and guard['kind'] == 'urm.moses.staging.activation.v1' and guard['manifestSHA256'] == release_sha
            and all(guard[k] == value[k] for k in ('releaseId', 'operationId'))
            and re.fullmatch(UUID, guard['verifiedOperationId']) and guard['verifiedOperationId'] != value['operationId']
            and type(guard['controlRevision']) is int and guard['controlRevision'] > 0
            and type(guard['issuedAt']) is int and type(guard['expiresAt']) is int
            and guard['issuedAt'] <= now < guard['expiresAt'] <= guard['issuedAt'] + 300, 'Guard grant unavailable or expired')
    receipt = audit / (guard['verifiedOperationId'] + '.receipt.json')
    protected(receipt, owner)
    raw = receipt.read_bytes()
    proof = document(raw)
    require(digest(raw) == guard['verificationSHA256'] and proof['role'] == 'staging-renderer'
            and proof['mode'] == 'verify' and proof['operationId'] == guard['verifiedOperationId']
            and proof['credentialPrincipal'] == ACCOUNT and proof['operatorKeySHA256'] == operator_key
            and (owner == 0 or (proof.get('hostAuthority') == 'moses-user-service' and proof['credentialType'] == 'external_account'
                                and proof.get('guardKeyPinSHA256') == pins['guard']))
            and all(proof[k] == value[k] for k in ('releaseId', 'commit', 'imageId')), 'Original staging verification required')
    old = container_info(proof['native']['containerId'])
    require(old['State']['Status'] == 'exited' and old['State']['StartedAt'] == proof['native']['startedAt']
            and old['RestartCount'] == 0 and old['Image'] == value['imageId'], 'Verified process must be retired intact')
    return {'guardSHA256': guard_sha, 'guardKeySHA256': guard_key, 'controlRevision': guard['controlRevision'],
            'verifiedOperationId': guard['verifiedOperationId'], 'expiresAt': guard['expiresAt'], 'signed': signed_guard}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['isolate', 'verify', 'activate', 'observe'])
    profile = p.add_mutually_exclusive_group()
    profile.add_argument('--isolated-dir', type=Path, help='Private offline rehearsal directory (config and state)')
    profile.add_argument('--user-service', action='store_true', help='Use the Moses UID 1000 staging installation')
    args = p.parse_args()
    isolated = args.isolated_dir is not None
    owner = os.geteuid()
    require(sys.platform == 'linux' and ((isolated and args.action in ('isolate', 'observe')) or
            (not isolated and args.action != 'isolate' and (args.user_service or owner == 0))),
            'Choose an offline rehearsal or a fixed host installation')
    pins = None
    if isolated:
        config = state = args.isolated_dir.absolute()
        role = 'isolated-verification'
        authority = 'isolated-verification'
    else:
        role = 'staging-renderer'
        if args.user_service:
            require(owner == 1000 and os.getegid() == 1000 and os.uname().nodename == 'MosesTheStrong',
                    'The user service requires the Moses staging operator account on its pinned host')
            home = Path(pwd.getpwuid(owner).pw_dir)
            config = home / '.config/urm-youtube-moses-staging'
            state = home / '.local/state/urm-youtube-moses-staging'
            installed = home / '.local/share/urm-youtube-moses-staging/renderer'
            require(Path(__file__).absolute() == installed / 'renderer.py' and INSPECT == installed / 'inspect-renderer.cjs',
                    'Install the reviewed user renderer at its fixed location')
            protected(installed, owner, directory=True)
            pins = signer_pins(installed, owner)
            authority = 'moses-user-service'
        else:
            config, state, authority = CONFIG, STATE, 'root-service'
        for script in (Path(__file__).absolute(), INSPECT):
            metadata = script.lstat()
            require(script.resolve() == script and stat.S_ISREG(metadata.st_mode) and metadata.st_uid == owner
                    and metadata.st_nlink == 1 and metadata.st_mode & 0o022 == 0,
                    'Install reviewed host scripts under the service operator identity before native staging use')
    os.umask(0o077)
    for path in {config, state}:
        protected(path, owner, directory=True)
    audit = state / 'audit'
    audit.mkdir(mode=0o700, exist_ok=True)
    protected(audit, owner, directory=True)
    scratch = state / 'scratch'
    value, release_sha, operator_key, signed_release = signed(config, 'release', 'operator', owner)
    require(pins is None or pins['operator'] == operator_key, 'Release signer differs from the installed operator pin')
    check_release(value, role)
    require(args.action == 'observe' or value['mode'] == ('enabled' if args.action == 'activate' else 'verify'),
            'Signed manifest mode and operator action must match')
    operation = value['operationId']
    intent = audit / (operation + '.intent.json')
    created = audit / (operation + '.container.json')
    receipt = audit / (operation + '.receipt.json')
    with (audit / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        observing = args.action == 'observe'
        check_scratch(scratch, not observing)
        check_image(value['imageId'])
        guard = None
        if observing:
            protected(intent, owner)
            original = document(intent.read_bytes())
            require(original.get('manifestSHA256') == release_sha and original.get('operatorKeySHA256') == operator_key
                    and (pins is None or (original.get('hostAuthority') == authority and original.get('guardKeyPinSHA256') == pins['guard'])),
                    'Original signed manifest and host signer identities required')
            protected(created, owner)
            cid = document(created.read_bytes())['containerId']
            if isolated:
                mounts = []
            else:
                credential_type, mounts = adc_mounts(config, owner)
                require(credential_type == original['credentialType'], 'Staging credential type changed')
        else:
            credential_type, mounts, dsn = None, [], ''
            if not isolated:
                credential_type, mounts = adc_mounts(config, owner)
                protected(config / 'sentry-dsn', owner)
                dsn = (config / 'sentry-dsn').read_text().strip()
                require(re.fullmatch(r'https://[A-Za-z0-9]+@[a-zA-Z0-9.-]+/[0-9]+', dsn), 'Invalid staging Sentry DSN')
                # Engine 28+ enforces loopback publishing on the host's local network.
                version = run(DOCKER + ['version', '--format', '{{.Server.Version}}']).decode()
                require(int(version.split('.')[0]) >= 28, 'Docker Engine 28 or newer required for loopback publishing')
            if args.action == 'activate':
                guard = activation_guard(config, audit, value, release_sha, operator_key, owner, pins)
            original = {**value, 'manifestSHA256': release_sha, 'operatorKeySHA256': operator_key,
                        'credentialPrincipal': ACCOUNT if not isolated else None, 'credentialType': credential_type,
                        'hostAuthority': authority, 'guardKeyPinSHA256': pins['guard'] if pins else None,
                        'guard': guard, 'signedRelease': signed_release}
            save_once(intent, original)
            cid = create(value, release_sha, scratch, mounts, dsn)
            require(re.fullmatch(r'[0-9a-f]{64}', cid), 'Container creation unconfirmed')
            save_once(created, {'containerId': cid})
            check_container(container_info(cid), value, release_sha, cid, scratch, mounts)
            if args.action == 'activate':
                require(activation_guard(config, audit, value, release_sha, operator_key, owner, pins) == guard,
                        'Guard changed during container creation')
            run(DOCKER + ['start', cid])
        observed = native(value, release_sha, cid, scratch, mounts)
        if receipt.exists():
            protected(receipt, owner)
            prior = document(receipt.read_bytes())
            require(all(prior['native'][k] == observed[k] for k in ('containerId', 'startedAt', 'runtimeId', 'device', 'inode')),
                    'Original verified process or scratch changed')
        else:
            save_once(receipt, {**original, 'native': observed, 'observedAt': int(time.time())})
        print(json.dumps({'operationId': operation, 'role': role, 'mode': value['mode'], 'containerId': cid,
                          'runtimeId': observed['runtimeId'], 'receiptSHA256': digest(receipt.read_bytes())}))


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(f'Native command {Path(error.cmd[0]).name} failed (exit {error.returncode}); inspect the original operation.',
              file=sys.stderr)
        sys.exit(1)
    except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired) as error:
        print(f'Moses verification stopped: {error}', file=sys.stderr)
        sys.exit(1)
