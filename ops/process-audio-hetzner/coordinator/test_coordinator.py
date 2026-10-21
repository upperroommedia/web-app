"""Portable source/journal tests. No Linux, Docker or capacity acceptance."""
import importlib.util
import os
import pathlib
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('coordinator', pathlib.Path(__file__).with_name('coordinator.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
ID = '00000000-0000-4000-8000-000000000001'


class SourceContract(unittest.TestCase):
    def daemon(self):
        daemon = object.__new__(c.Coordinator)
        daemon.lock = threading.RLock()
        daemon.policy_bytes = b'CONTROLLED_POLICY_NOT_NATIVE_CAPACITY'
        daemon.completed = {}
        daemon.live = None
        daemon.fenced = True
        return daemon

    def operation(self):
        return dict(id=ID, kind='legacy-full', peer={'fixture': 'CONTROLLED'},
                    sequence=0, eventSHA256=None, state='intent')

    def test_duplicate_keys_and_nonfinite_json_deny(self):
        for raw in ('{"id":1,"id":2}', '{"nested":{"x":1,"x":2}}', '{"v":NaN}', '{"v":Infinity}'):
            with self.subTest(raw=raw), self.assertRaises(RuntimeError):
                c.load_json(raw)

    def test_socket_directory_requires_nonowner_traversal_without_write(self):
        for mode, allowed in ((0o700, False), (0o711, True), (0o755, True), (0o777, False), (0o750, False)):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix='owned-socket-source-') as directory:
                os.chmod(directory, mode)
                actual = os.lstat(directory)
                # UID is CONTROLLED on non-root development machines. Native
                # directory mode/stat and the validator are actual source.
                native = type('NativeStat', (), {'st_mode': actual.st_mode, 'st_uid': 0})()
                with patch.object(c.os, 'lstat', return_value=native):
                    if allowed: c.socket_directory(directory)
                    else:
                        with self.assertRaises(RuntimeError): c.socket_directory(directory)

    @unittest.skipUnless(os.geteuid() == 0 and hasattr(os, 'fork'), 'requires root-owned temporary socket fixture')
    def test_actual_nonowner_unix_socket_permission_boundary(self):
        with tempfile.TemporaryDirectory(prefix='owned-native-socket-') as directory:
            os.chmod(directory, 0o711)
            target = pathlib.Path(directory, 'coordinator.sock')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(target))
                os.chmod(target, 0o666)
                listener.listen(1)
                listener.settimeout(2)
                for mode, expected in ((0o700, False), (0o711, True)):
                    os.chmod(directory, mode)
                    pid = os.fork()
                    if pid == 0:
                        try:
                            os.setgroups([])
                            os.setgid(65534)
                            os.setuid(65534)
                            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                                client.settimeout(1)
                                client.connect(str(target))
                            os._exit(0 if expected else 1)
                        except PermissionError: os._exit(0 if not expected else 1)
                        except Exception: os._exit(2)
                    try:
                        if expected:
                            connection, _ = listener.accept()
                            connection.close()
                    finally:
                        _, status = os.waitpid(pid, 0)
                    self.assertEqual(os.waitstatus_to_exitcode(status), 0)

    def test_boolean_version_extra_grant_and_paths_deny_before_native_reads(self):
        daemon = self.daemon()
        for request in ({'v': True, 'id': ID, 'action': 'get'},
                        {'v': 1, 'id': ID, 'action': 'get', 'authorized': True},
                        {'v': 1, 'id': ID, 'action': 'get', 'path': '/tmp/foreign'},
                        {'v': 1, 'id': '../foreign', 'action': 'get'}):
            with self.subTest(request=request), patch.object(c, 'process_identity', side_effect=AssertionError('native read forbidden')):
                with self.assertRaises((RuntimeError, ValueError)):
                    daemon.handle(request, (1, 1, 1))

    def test_restart_fence_denies_reserve_before_inventory(self):
        daemon = self.daemon()
        with patch.object(daemon, 'inventory', side_effect=AssertionError('native read forbidden')):
            with self.assertRaises(RuntimeError):
                daemon.handle({'v': 1, 'action': 'reserve', 'id': ID, 'kind': 'legacy-full'}, (1, 1, 1))

    def test_actual_owned_journal_create_only_hash_chain_and_no_state_advance_on_failed_commit(self):
        daemon, operation = self.daemon(), self.operation()
        with tempfile.TemporaryDirectory(prefix='owned-coordinator-source-') as directory, patch.object(c, 'STATE', pathlib.Path(directory)):
            daemon.event(operation, 'intent')
            first = c.load_json(pathlib.Path(directory, ID + '-000001.json').read_bytes())
            self.assertEqual(operation['eventSHA256'], c.digest(first))
            self.assertEqual(first['previous'], None)
            daemon.event(operation, 'reserved')
            second = c.load_json(pathlib.Path(directory, ID + '-000002.json').read_bytes())
            self.assertEqual(second['previous'], c.digest(first))
            with self.assertRaises(FileExistsError):
                daemon.immutable(ID + '-000001.json', {'rewritten': True})
            original = operation.copy()
            with patch.object(daemon, 'immutable', side_effect=OSError('CONTROLLED_ACK_OR_DISK_FAILURE')):
                with self.assertRaises(OSError):
                    daemon.event(operation, 'enrolled')
            self.assertEqual(operation, original)
            self.assertEqual(c.load_json(pathlib.Path(directory, ID + '-000001.json').read_bytes()), first)

    def test_terminal_journal_alone_cannot_return_success_before_release(self):
        daemon, operation = self.daemon(), self.operation()
        for terminal in ('closed', 'unstarted'):
            operation.update(state=terminal, eventSHA256='a' * 64)
            with self.assertRaises(RuntimeError):
                daemon.public(operation)
            operation['released'] = True
            result = daemon.public(operation)
            self.assertEqual(result['receiptHash'], 'a' * 64)
            self.assertEqual(result.get('groupAbsent'), True if terminal == 'closed' else None)
            del operation['released']

    def test_controlled_stop_signal_is_not_drain_and_is_never_resent(self):
        daemon, operation = self.daemon(), self.operation()
        operation.update(state='enrolled', scope={'fixture': 'CONTROLLED'}, child={'fixture': 'CONTROLLED'}, childfd=123, stopLock=threading.Lock())
        with tempfile.TemporaryDirectory(prefix='owned-stop-source-') as directory:
            path = pathlib.Path(directory)
            # Native process/cgroup facts are CONTROLLED here; only the source
            # issuance fence and actual owned temporary write are exercised.
            with patch.object(daemon, 'scope_path', return_value=path), patch.object(daemon, 'scope_empty', return_value=False), patch.object(c.time, 'monotonic', side_effect=[0, 4]):
                with self.assertRaises(RuntimeError):
                    daemon.stop_scope(operation, wait=True)
            self.assertEqual((path / 'cgroup.kill').read_text(), '1')
            self.assertTrue(operation['killIssued'])
            (path / 'cgroup.kill').write_text('CONTROLLED_EXISTING_ACK')
            with patch.object(daemon, 'scope_path', return_value=path), patch.object(daemon, 'scope_empty', return_value=True), patch.object(c, 'dead', return_value=True):
                daemon.stop_scope(operation, wait=True)
            self.assertEqual((path / 'cgroup.kill').read_text(), 'CONTROLLED_EXISTING_ACK')
            self.assertEqual(operation['state'], 'enrolled')

    def test_controlled_late_positive_drain_read_does_not_escape_original_deadline(self):
        daemon, operation = self.daemon(), self.operation()
        operation.update(state='enrolled', scope={'fixture': 'CONTROLLED'}, child={'fixture': 'CONTROLLED'}, childfd=123, stopLock=threading.Lock())
        with patch.object(daemon, 'scope_path'), patch.object(daemon, 'scope_empty', return_value=True), patch.object(c, 'dead', return_value=True), patch.object(c.time, 'monotonic', side_effect=[0, 1, 4]):
            with self.assertRaises(RuntimeError):
                daemon.stop_scope(operation, wait=True)
        self.assertEqual(operation['state'], 'enrolled')


if __name__ == '__main__':
    unittest.main()
