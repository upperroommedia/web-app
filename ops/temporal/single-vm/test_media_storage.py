"""Offline guard/enrollment/CAS tests; never invoke mount, metadata, or Kubernetes."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import os
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('media_storage', Path(__file__).with_name('media-storage.py'))
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)
CONFIG = {'schemaVersion': 1, 'projectId': 'urm-app-staging', 'instanceName': 'urm-temporal-staging', 'instanceId': '1234', 'privateIp': '10.180.0.2', 'mediaFilesystemUuid': '12345678-1234-1234-1234-123456789abc'}


def configmap():
    return {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'local-path-config', 'namespace': 'kube-system', 'uid': '11111111-1111-1111-1111-111111111111', 'resourceVersion': '10'}, 'data': {'config.json': media.canonical(media.DEFAULT), 'helperPod.yaml': 'reviewed helper', 'setup': 'mkdir', 'teardown': 'rmdir'}}


class Transport:
    def __init__(self):
        self.cm = configmap()
        self.saved = None
        self.calls = []
        self.writes = 0
        self.skip = True
        self.race = None

    def secure(self, _path):
        media.require(self.skip, 'SKIP_ROOT_REGULAR_FILE_REQUIRED')

    def reader(self, _path):
        if self.saved is None:
            raise FileNotFoundError('protected record missing')
        return copy.deepcopy(self.saved)

    def writer(self, _path, value):
        self.writes += 1
        assert self.saved is None
        self.saved = copy.deepcopy(value)

    def runner(self, args):
        self.calls.append(args)
        assert args[:6] == ['/usr/local/bin/k3s', 'kubectl', '--server=https://10.180.0.2:6443', '-n', 'kube-system', args[5]]
        if args[5] == 'get':
            return json.dumps(self.cm)
        assert args[5:9] == ['patch', 'configmap', 'local-path-config', '--type=json']
        operations = json.loads(args[-1])
        assert [op['path'] for op in operations] == ['/metadata/uid', '/metadata/resourceVersion', '/data', '/data/config.json']
        assert [op['op'] for op in operations] == ['test', 'test', 'test', 'replace']
        if self.race:
            self.race(self.cm)
        assert operations[0]['value'] == self.cm['metadata']['uid'], 'native UID CAS'
        assert operations[1]['value'] == self.cm['metadata']['resourceVersion'], 'native RV CAS'
        assert operations[2]['value'] == self.cm['data'], 'full data CAS'
        self.cm['data']['config.json'] = operations[3]['value']
        self.cm['metadata']['resourceVersion'] = str(int(self.cm['metadata']['resourceVersion']) + 1)
        return '{}'

    def operate(self, action):
        with patch.object(media.os.path, 'lexists', return_value=self.saved is not None):
            return media.operate(action, CONFIG, runner=self.runner, guard=lambda _config: True, reader=self.reader, writer=self.writer, secure=self.secure)


class MountTests(unittest.TestCase):
    def setUp(self):
        self.mounted = {'filesystems': [{'target': media.TARGET, 'source': '/dev/sdb', 'fstype': 'ext4', 'uuid': CONFIG['mediaFilesystemUuid']}]}
        self.root = {'filesystems': [{'target': '/', 'source': '/dev/sda1', 'fstype': 'ext4', 'uuid': '22222222-2222-2222-2222-222222222222'}]}

    def validate(self):
        return media.validate_mount(CONFIG, self.mounted, self.root, '/dev/sdb', CONFIG['mediaFilesystemUuid'])

    def test_exact_dedicated_mount_and_canonical_config(self):
        self.assertTrue(self.validate())
        for key, value in [('mediaFilesystemUuid', None), ('mediaFilesystemUuid', CONFIG['mediaFilesystemUuid'].upper()), ('instanceName', 'foreign'), ('privateIp', '10.42.0.4'), ('privateIp', '8.8.8.8')]:
            with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                media.validate_config({**CONFIG, key: value})

    def test_wrong_uuid_device_target_root_and_filesystem_reject(self):
        for field, value in [('target', '/var/lib'), ('source', '/dev/sdc'), ('uuid', self.root['filesystems'][0]['uuid']), ('fstype', 'xfs')]:
            with self.subTest(field=field):
                original = self.mounted['filesystems'][0][field]
                self.mounted['filesystems'][0][field] = value
                with self.assertRaises(RuntimeError):
                    self.validate()
                self.mounted['filesystems'][0][field] = original
        self.root['filesystems'][0]['source'] = '/dev/sdb'
        with self.assertRaisesRegex(RuntimeError, 'ROOT_FALLBACK'):
            self.validate()
        with self.assertRaisesRegex(RuntimeError, 'DEDICATED_DEVICE'):
            media.validate_mount(CONFIG, self.mounted, self.root, '/dev/sdb', 'different')

    def test_missing_device_and_mount_fail_before_api_or_enrollment(self):
        calls = []
        with patch.object(media.Path, 'is_symlink', return_value=False), patch.object(media.os.path, 'realpath', return_value=media.TARGET), patch.object(media.os.path, 'exists', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'DEVICE_MISSING'):
                media.mount_guard(CONFIG, lambda args: calls.append(args))
        self.assertEqual(calls, [])
        def bad_mount(_config):
            raise RuntimeError('WRONG_UUID')
        for action in ('enroll', 'reconcile', 'check'):
            with self.assertRaisesRegex(RuntimeError, 'WRONG_UUID'):
                media.operate(action, CONFIG, guard=bad_mount, runner=lambda args: calls.append(args), writer=lambda *args: calls.append(args))
        with self.assertRaisesRegex(RuntimeError, 'WRONG_UUID'):
            media.boot_guard(CONFIG, guard=bad_mount, reader=lambda *args: calls.append(args))
        self.assertEqual(calls, [])

    def test_each_wrong_mount_blocks_boot_guard_and_operator_before_state_or_api(self):
        invalid = []
        for field, value in [('target', '/'), ('source', '/dev/sdc'), ('uuid', 'foreign'), ('fstype', 'xfs')]:
            mounted = copy.deepcopy(self.mounted)
            mounted['filesystems'][0][field] = value
            invalid.append((mounted, self.root))
        root_fallback = copy.deepcopy(self.root)
        root_fallback['filesystems'][0]['source'] = '/dev/sdb'
        invalid.append((self.mounted, root_fallback))
        for mounted, root in invalid:
            calls = []
            def guard(config):
                return media.validate_mount(config, mounted, root, '/dev/sdb', CONFIG['mediaFilesystemUuid'])
            with self.assertRaises(RuntimeError):
                media.boot_guard(CONFIG, guard=guard, reader=lambda *args: calls.append(args))
            for action in ('enroll', 'reconcile', 'check'):
                with self.assertRaises(RuntimeError):
                    media.operate(action, CONFIG, guard=guard, runner=lambda *args: calls.append(args), writer=lambda *args: calls.append(args))
            self.assertEqual(calls, [], 'wrong mount cannot reach state, API or provisioning')

    def test_actual_mount_transport_uses_exact_by_id_and_blkid(self):
        calls = []
        device = '/dev/disk/by-id/google-urm-temporal-staging-media'
        def runner(args):
            calls.append(args)
            if args[0] == 'blkid':
                self.assertEqual(args[-1], device)
                return CONFIG['mediaFilesystemUuid'] + '\n'
            return json.dumps(self.root if args[-1] == '/' else self.mounted)
        with patch.object(media.Path, 'is_symlink', return_value=False), patch.object(media.os.path, 'exists', return_value=True), patch.object(media.os.path, 'realpath', side_effect=lambda value: '/dev/sdb' if value == device else value):
            self.assertTrue(media.mount_guard(CONFIG, runner))
        self.assertEqual(len(calls), 3)

    def test_boot_guard_missing_record_requires_explicit_bound_permit(self):
        with patch.object(media.os.path, 'lexists', return_value=False):
            with self.assertRaises(FileNotFoundError):
                media.boot_guard(CONFIG, guard=lambda _: True, reader=lambda _: (_ for _ in ()).throw(FileNotFoundError()))
            with self.assertRaisesRegex(RuntimeError, 'PERMIT_REQUIRED'):
                media.boot_guard(CONFIG, guard=lambda _: True, reader=lambda _: {'configSha256': 'foreign'})
            self.assertTrue(media.boot_guard(CONFIG, guard=lambda _: True, reader=lambda _: {'schemaVersion': 1, 'configSha256': media.digest(CONFIG)}))
        record = media.enrollment(configmap(), CONFIG)
        secure = []
        with patch.object(media.os.path, 'lexists', return_value=True):
            self.assertTrue(media.boot_guard(CONFIG, guard=lambda _: True, reader=lambda _: record, secure=lambda path: secure.append(path)))
        self.assertEqual(secure, [media.SKIP])


class ProtectedStateTests(unittest.TestCase):
    def test_only_root_private_regular_files_are_authority(self):
        for mode, uid, valid in [(stat.S_IFREG | 0o600, 0, True), (stat.S_IFREG | 0o644, 0, False), (stat.S_IFREG | 0o600, 1000, False), (stat.S_IFLNK | 0o600, 0, False)]:
            with patch.object(media.os, 'lstat', return_value=SimpleNamespace(st_mode=mode, st_uid=uid)):
                if valid:
                    self.assertEqual(media.secure_file('fixture'), 'fixture')
                else:
                    with self.assertRaises(RuntimeError):
                        media.secure_file('fixture')

    def test_write_once_uses_exclusive_native_file_and_preserves_existing_record(self):
        with tempfile.TemporaryDirectory(prefix='urm-media-enrollment-') as directory:
            record = str(Path(directory) / 'record.json')
            wanted = media.enrollment(configmap(), CONFIG)
            with patch.object(media.os, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)):
                media.write_once(record, wanted)
                before = Path(record).read_bytes()
                with self.assertRaises(FileExistsError):
                    media.write_once(record, {**wanted, 'configMapUid': 'foreign'})
            self.assertEqual(Path(record).read_bytes(), before)
            self.assertEqual(json.loads(before), wanted)
            self.assertEqual(os.stat(record).st_mode & 0o777, 0o600)


class EnrollmentTests(unittest.TestCase):
    def test_explicit_enroll_once_reconcile_and_check_are_idempotent(self):
        transport = Transport()
        transport.operate('enroll')
        saved = copy.deepcopy(transport.saved)
        transport.operate('enroll')
        self.assertEqual(transport.writes, 1)
        self.assertEqual(transport.saved, saved)
        other = {k: v for k, v in transport.cm['data'].items() if k != 'config.json'}
        transport.operate('reconcile')
        transport.operate('reconcile')
        transport.operate('check')
        self.assertEqual(len([args for args in transport.calls if args[5] == 'patch']), 1)
        self.assertEqual({k: v for k, v in transport.cm['data'].items() if k != 'config.json'}, other)
        self.assertEqual(json.loads(transport.cm['data']['config.json']), media.DESIRED)

    def test_missing_enrollment_and_skip_never_reenroll_or_call_api(self):
        for action in ('reconcile', 'check'):
            transport = Transport()
            with self.assertRaises(FileNotFoundError):
                transport.operate(action)
            self.assertEqual(transport.calls, [])
            self.assertEqual(transport.writes, 0)
        transport = Transport()
        transport.skip = False
        with self.assertRaisesRegex(RuntimeError, 'SKIP_ROOT'):
            transport.operate('enroll')
        self.assertEqual(transport.calls, [])

    def test_recreation_nonconfig_and_unreviewed_node_map_cannot_be_adopted(self):
        for mutate in (lambda cm: cm['metadata'].update(uid='33333333-3333-3333-3333-333333333333'), lambda cm: cm['data'].update(setup='changed'), lambda cm: cm['data'].update({'config.json': '{"nodePathMap":[]}'}), lambda cm: cm['data'].update(extra='unreviewed')):
            transport = Transport()
            transport.operate('enroll')
            saved = copy.deepcopy(transport.saved)
            mutate(transport.cm)
            for action in ('reconcile', 'enroll'):
                with self.assertRaises(RuntimeError):
                    transport.operate(action)
            self.assertEqual(transport.writes, 1)
            self.assertEqual(saved, transport.saved)

    def test_native_cas_rejects_recreated_uid_rv_or_other_data_race(self):
        for race in (lambda cm: cm['metadata'].update(uid='44444444-4444-4444-4444-444444444444'), lambda cm: cm['metadata'].update(resourceVersion='11'), lambda cm: cm['data'].update(teardown='changed')):
            transport = Transport()
            transport.operate('enroll')
            transport.race = race
            with self.assertRaises(AssertionError):
                transport.operate('reconcile')
            self.assertEqual(json.loads(transport.cm['data']['config.json']), media.DEFAULT)

    def test_packaged_manifest_rewrite_skip_persists_dedicated_map(self):
        transport = Transport()
        transport.operate('enroll')
        transport.operate('reconcile')
        def packaged_start():
            if not transport.skip:
                transport.cm['data']['config.json'] = media.canonical(media.DEFAULT)
        packaged_start()
        self.assertEqual(json.loads(transport.cm['data']['config.json']), media.DESIRED)
        transport.operate('check')
        transport.skip = False
        packaged_start()
        self.assertEqual(json.loads(transport.cm['data']['config.json']), media.DEFAULT)
        with self.assertRaisesRegex(RuntimeError, 'SKIP_ROOT'):
            transport.operate('check')


if __name__ == '__main__':
    unittest.main()
