#!/usr/bin/env python3
"""Dedicated media mount guard and explicitly enrolled local-path ConfigMap CAS.

No disk formatting, mounting, Kubernetes resource creation, or automatic enrollment.
"""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

TARGET = '/var/lib/urm-temporal/media'
SKIP = '/var/lib/rancher/k3s/server/manifests/local-storage.yaml.skip'
RECORD = '/etc/urm-temporal/media-storage-enrollment.json'
INITIAL = '/etc/urm-temporal/media-storage.initializing'
DEFAULT = {'nodePathMap': [{'node': 'DEFAULT_PATH_FOR_NON_LISTED_NODES', 'paths': ['/var/lib/rancher/k3s/storage']}]}
DESIRED = {'nodePathMap': [{'node': 'DEFAULT_PATH_FOR_NON_LISTED_NODES', 'paths': [TARGET]}]}
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def validate_config(config):
    require(isinstance(config, dict) and set(config) == {'schemaVersion', 'projectId', 'instanceName', 'instanceId', 'privateIp', 'mediaFilesystemUuid'}, 'CONFIG_SHAPE')
    environment = {'urm-app-staging': 'staging', 'urm-app': 'production'}.get(config['projectId'])
    require(config['schemaVersion'] == 1 and environment is not None and config['instanceName'] == 'urm-temporal-' + environment, 'CONFIG_PROJECT_INSTANCE')
    require(isinstance(config['instanceId'], str) and re.fullmatch(r'[0-9]+', config['instanceId']), 'CONFIG_NATIVE_INSTANCE_ID')
    try:
        address = ipaddress.ip_address(config['privateIp'])
        allowed = address.version == 4 and address in ipaddress.ip_network('10.0.0.0/8') and address not in ipaddress.ip_network('10.42.0.0/15')
    except ValueError:
        allowed = False
    require(allowed, 'CONFIG_PRIVATE_IP')
    require(isinstance(config['mediaFilesystemUuid'], str) and UUID.fullmatch(config['mediaFilesystemUuid']), 'CONFIG_ACTUAL_FILESYSTEM_UUID')
    return config


def secure_file(path):
    info = os.lstat(path)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o077, 'ROOT_PROTECTED_REGULAR_FILE_REQUIRED')
    return path


def read_protected(path):
    secure_file(path)
    with open(path, encoding='utf8') as stream:
        return json.load(stream)


def run(args):
    return subprocess.check_output(args, text=True, timeout=25)


def validate_mount(config, mounted, root, device_real, device_uuid):
    validate_config(config)
    for row in (mounted, root):
        require(isinstance(row, dict) and isinstance(row.get('filesystems'), list) and len(row['filesystems']) == 1, 'MOUNT_SHAPE')
    media, root_fs = mounted['filesystems'][0], root['filesystems'][0]
    require(media.get('target') == TARGET and root_fs.get('target') == '/', 'EXACT_MOUNT_TARGET_REQUIRED')
    require(media.get('fstype') == 'ext4' and media.get('uuid') == config['mediaFilesystemUuid'], 'DEDICATED_UUID_EXT4_REQUIRED')
    require(isinstance(device_real, str) and device_real.startswith('/dev/') and media.get('source') == device_real and device_uuid == config['mediaFilesystemUuid'], 'DEDICATED_DEVICE_REQUIRED')
    require(device_real != root_fs.get('source') and media.get('target') != root_fs.get('target') and media.get('uuid') != root_fs.get('uuid'), 'ROOT_FALLBACK_FORBIDDEN')
    return True


def mount_guard(config, runner=run):
    validate_config(config)
    require(not Path(TARGET).is_symlink() and os.path.realpath(TARGET) == TARGET, 'MOUNT_SYMLINK_FORBIDDEN')
    device = '/dev/disk/by-id/google-' + config['instanceName'] + '-media'
    require(os.path.exists(device), 'DEDICATED_DEVICE_MISSING')
    args = ['findmnt', '--json', '--output', 'TARGET,SOURCE,FSTYPE,UUID', '--target']
    mounted = json.loads(runner(args + [TARGET]))
    root = json.loads(runner(args + ['/']))
    device_uuid = runner(['blkid', '-s', 'UUID', '-o', 'value', device]).strip()
    return validate_mount(config, mounted, root, os.path.realpath(device), device_uuid)


def validate_cm(cm, record=None):
    require(isinstance(cm, dict) and cm.get('apiVersion') == 'v1' and cm.get('kind') == 'ConfigMap', 'CM_KIND')
    meta = cm.get('metadata', {})
    require(meta.get('name') == 'local-path-config' and meta.get('namespace') == 'kube-system' and isinstance(meta.get('uid'), str) and UUID.fullmatch(meta['uid']), 'CM_IDENTITY')
    require(isinstance(meta.get('resourceVersion'), str) and re.fullmatch(r'[1-9][0-9]*', meta['resourceVersion']), 'CM_NATIVE_RESOURCE_VERSION')
    require(cm.get('binaryData') is None, 'CM_UNREVIEWED_BINARY_DATA')
    data = cm.get('data')
    require(isinstance(data, dict) and set(data) == {'config.json', 'helperPod.yaml', 'setup', 'teardown'} and all(isinstance(value, str) for value in data.values()), 'CM_EXACT_DATA_KEYS')
    other_hash = digest({key: value for key, value in data.items() if key != 'config.json'})
    if record is not None:
        require(meta['uid'] == record['configMapUid'], 'CM_RECREATED')
        require(other_hash == record['nonConfigSha256'], 'CM_NON_CONFIG_DATA_CHANGED')
    parsed = json.loads(data['config.json'])
    require(parsed in (DEFAULT, DESIRED), 'UNREVIEWED_NODE_PATH_MAP')
    return parsed, other_hash


def validate_record(record, config):
    require(isinstance(record, dict) and set(record) == {'schemaVersion', 'configSha256', 'configMapUid', 'nonConfigSha256'}, 'ENROLLMENT_SHAPE')
    require(record['schemaVersion'] == 1 and record['configSha256'] == digest(config) and isinstance(record['configMapUid'], str) and UUID.fullmatch(record['configMapUid']) and isinstance(record['nonConfigSha256'], str) and re.fullmatch(r'[0-9a-f]{64}', record['nonConfigSha256']), 'ENROLLMENT_AUTHORITY_CHANGED')
    return record


def boot_guard(config, guard=mount_guard, reader=read_protected, record_path=RECORD, initial_path=INITIAL, skip_path=SKIP, secure=secure_file):
    guard(config)  # Must precede any state or Kubernetes access.
    if os.path.lexists(record_path):
        validate_record(reader(record_path), config)
        secure(skip_path)
    else:
        permit = reader(initial_path)
        require(permit == {'schemaVersion': 1, 'configSha256': digest(config)}, 'INITIAL_ENROLLMENT_PERMIT_REQUIRED')
    return True


def enrollment(cm, config):
    validate_config(config)
    _, other_hash = validate_cm(cm)
    return {'schemaVersion': 1, 'configSha256': digest(config), 'configMapUid': cm['metadata']['uid'], 'nonConfigSha256': other_hash}


def write_once(path, value):
    parent = os.lstat(Path(path).parent)
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and not parent.st_mode & 0o022, 'ROOT_PROTECTED_ENROLLMENT_DIRECTORY_REQUIRED')
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf8') as stream:
        stream.write(canonical(value) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def cm_patch(cm, record):
    validate_cm(cm, record)
    return [
        {'op': 'test', 'path': '/metadata/uid', 'value': record['configMapUid']},
        {'op': 'test', 'path': '/metadata/resourceVersion', 'value': cm['metadata']['resourceVersion']},
        {'op': 'test', 'path': '/data', 'value': cm['data']},
        {'op': 'replace', 'path': '/data/config.json', 'value': canonical(DESIRED)},
    ]


def operate(action, config, runner=run, guard=mount_guard, reader=read_protected, writer=write_once, secure=secure_file, record_path=RECORD, skip_path=SKIP):
    require(action in ('enroll', 'reconcile', 'check'), 'EXPLICIT_ACTION_REQUIRED')
    guard(config)
    secure(skip_path)
    kube = ['/usr/local/bin/k3s', 'kubectl', '--server=https://' + config['privateIp'] + ':6443', '-n', 'kube-system']
    saved = None if action == 'enroll' else validate_record(reader(record_path), config)
    before = json.loads(runner(kube + ['get', 'configmap', 'local-path-config', '-o', 'json']))
    if action == 'enroll':
        wanted = enrollment(before, config)
        if os.path.lexists(record_path):
            require(validate_record(reader(record_path), config) == wanted, 'ENROLLMENT_ALREADY_BOUND')
        else:
            writer(record_path, wanted)
        return {'enrolled': True, 'configMapUid': wanted['configMapUid']}
    current, _ = validate_cm(before, saved)
    if action == 'check':
        require(current == DESIRED, 'DEDICATED_MAP_NOT_READY')
    elif current != DESIRED:
        runner(kube + ['patch', 'configmap', 'local-path-config', '--type=json', '-p', json.dumps(cm_patch(before, saved))])
    after = json.loads(runner(kube + ['get', 'configmap', 'local-path-config', '-o', 'json']))
    require(validate_cm(after, saved)[0] == DESIRED, 'DEDICATED_MAP_POSTCHECK')
    require({k: v for k, v in before['data'].items() if k != 'config.json'} == {k: v for k, v in after['data'].items() if k != 'config.json'}, 'NON_CONFIG_POSTCHECK')
    return {'mountVerified': True, 'configVerified': True, 'configMapUid': saved['configMapUid'], 'resourceVersion': after['metadata']['resourceVersion']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('mount-check', 'guard', 'enroll', 'reconcile', 'check'))
    parser.add_argument('--config', default='/etc/urm-temporal/media-storage.json')
    args = parser.parse_args()
    config = validate_config(read_protected(args.config))
    result = {'mountVerified': mount_guard(config)} if args.action == 'mount-check' else {'mountVerified': boot_guard(config)} if args.action == 'guard' else operate(args.action, config)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'passed': False, 'error': str(error) if isinstance(error, RuntimeError) else 'OPERATION_FAILED'}), file=sys.stderr)
        sys.exit(1)
