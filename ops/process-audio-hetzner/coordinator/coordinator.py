"""Root-host, one-slot media admission. No automatic restart recovery.

Linux native interfaces only; no shell, external commands, network API, policy
discovery, PID adoption or permissive resource defaults.
"""
import ctypes
import hashlib
import http.client
import json
import os
import re
import select
import signal
import socket
import stat
import struct
import threading
import time
import uuid
from pathlib import Path

SOCKET = Path('/run/urm-host-media/coordinator.sock')
POLICY = Path('/etc/urm-host-media/policy.json')
STATE = Path('/var/lib/urm-host-media')
GIB = 1024 ** 3
WORK = 64 * GIB
HEADROOM = 16 * GIB
TMPFS = 256 * 1024 ** 2
LIMIT = 16 * 1024
KINDS = {'legacy-full', 'canary', 'acquisition'}
COVERAGE = {'pipeline-staging', 'pipeline-production', 'browser-staging',
            'browser-production', 'po-staging', 'po-production'}
ID = re.compile(r'^[a-f0-9]{64}$')
SHA = re.compile(r'^sha256:[a-f0-9]{64}$')
UNAVAILABLE = {'v': 1, 'error': 'UNAVAILABLE'}


def require(value):
    if not value:
        raise RuntimeError('UNAVAILABLE')


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys))


def integer(value, minimum=1):
    require(type(value) is int and minimum <= value < 2 ** 53)
    return value


def load_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: require(False))


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def read(path, maximum=65536):
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        data = os.read(fd, maximum + 1)
        require(len(data) <= maximum)
        return data.decode('utf-8', 'strict')
    finally:
        os.close(fd)


def private_directory(path):
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
            and info.st_mode & 0o077 == 0)
    return info


def socket_directory(path):
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
            and stat.S_IMODE(info.st_mode) in (0o711, 0o755))
    return info


def root_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
            and info.st_nlink == 1 and info.st_mode & 0o222 == 0)
    return fd, info


def validate_policy(p):
    exact(p, {'v', 'bootId', 'hostRoot', 'coordinatorSHA256', 'containers', 'hostProcesses', 'operationCgroupRoot',
              'fullWorkspace', 'streamWorkspace', 'memoryBytes', 'pids',
              'cpuMicrosPerSecond', 'hostMemoryHeadroomBytes', 'hostPidHeadroom'})
    require(type(p['v']) is int and p['v'] == 1)
    require(type(p['bootId']) is str and str(uuid.UUID(p['bootId'])) == p['bootId'])
    exact(p['hostRoot'], {'device', 'inode', 'mountId'})
    for value in p['hostRoot'].values(): integer(value)
    require(type(p['coordinatorSHA256']) is str and re.fullmatch('[a-f0-9]{64}', p['coordinatorSHA256']))
    for key in ('memoryBytes', 'pids', 'cpuMicrosPerSecond',
                'hostMemoryHeadroomBytes', 'hostPidHeadroom'):
        integer(p[key])
    require(type(p['containers']) is list and 2 <= len(p['containers']) <= 32)
    covered, ids = set(), set()
    for c in p['containers']:
        exact(c, {'id', 'image', 'uid', 'cgroup', 'initPid', 'initStartTicks', 'pidNamespace', 'startedAt', 'memoryBytes', 'pids',
                  'cpuMicrosPerSecond', 'logMaxBytes', 'logMaxFiles', 'covers',
                  'fullMount', 'streamMount', 'tmpfs', 'authMounts'})
        require(type(c['id']) is str and ID.fullmatch(c['id']) and c['id'] not in ids)
        require(type(c['image']) is str and SHA.fullmatch(c['image']))
        for key in ('uid', 'initPid', 'initStartTicks', 'memoryBytes', 'pids', 'cpuMicrosPerSecond',
                    'logMaxBytes', 'logMaxFiles'):
            integer(c[key])
        require(type(c['covers']) is list and set(c['covers']) <= COVERAGE)
        require(type(c['pidNamespace']) is str and re.fullmatch(r'pid:\[[0-9]+\]', c['pidNamespace'])
                and type(c['startedAt']) is str and c['startedAt'].endswith('Z'))
        covered.update(c['covers'])
        ids.add(c['id'])
        require(type(c['cgroup']) is str and c['cgroup'].startswith('/')
                and '..' not in c['cgroup'].split('/'))
        require(type(c['fullMount']) is bool and type(c['streamMount']) is bool)
        require(not (c['fullMount'] and c['streamMount']))
        require(type(c['tmpfs']) is dict)
        for destination, options in c['tmpfs'].items():
            require(type(destination) is str and destination.startswith('/')
                    and '..' not in destination.split('/') and type(options) is str)
            flags = options.split(',')
            size = [x[5:] for x in flags if x.startswith('size=')]
            require({'noexec', 'nosuid', 'nodev'} <= set(flags) and len(size) == 1
                    and size[0].isdigit() and 0 < int(size[0]) <= c['memoryBytes'])
        require(type(c['authMounts']) is list and len(c['authMounts']) <= 8)
        for m in c['authMounts']:
            exact(m, {'destination', 'source', 'device', 'inode', 'mountId', 'projectId', 'hardBytes'})
            for key in ('destination', 'source'):
                require(type(m[key]) is str and m[key].startswith('/')
                        and '..' not in m[key].split('/'))
            require(m['destination'] not in ('/', '/workspace', '/workspace/host-resource',
                                              '/run/urm-host-media', '/sys/fs/cgroup', '/var/run/docker.sock'))
            require(os.path.realpath(m['source']) == m['source'])
            for key in ('device', 'inode', 'mountId', 'projectId', 'hardBytes'): integer(m[key])
            require(m['hardBytes'] % 1024 == 0)
    require(covered == COVERAGE)
    require(type(p['hostProcesses']) is list and len(p['hostProcesses']) <= 256)
    for h in p['hostProcesses']:
        exact(h, {'exe', 'sha256', 'cgroup'})
        require(type(h['exe']) is str and h['exe'].startswith('/'))
        require(type(h['sha256']) is str and re.fullmatch('[a-f0-9]{64}', h['sha256']))
        require(type(h['cgroup']) is str and h['cgroup'].startswith('/'))
    for key in ('fullWorkspace', 'streamWorkspace'):
        w = p[key]
        exact(w, {'path', 'device', 'inode', 'mountId', 'projectId', 'baselineQuotaBytes'})
        require(type(w['path']) is str and w['path'].startswith('/')
                and os.path.realpath(w['path']) == w['path'])
        for field in ('device', 'inode', 'mountId'):
            integer(w[field])
        integer(w['projectId'], 0)
        integer(w['baselineQuotaBytes'], 0)
    require(p['fullWorkspace']['projectId'] > 0 and p['streamWorkspace']['projectId'] == 0
            and p['streamWorkspace']['baselineQuotaBytes'] == 0)
    require(p['fullWorkspace']['path'] != p['streamWorkspace']['path'])
    require(type(p['operationCgroupRoot']) is str
            and p['operationCgroupRoot'].startswith('/sys/fs/cgroup/')
            and os.path.realpath(p['operationCgroupRoot']) == p['operationCgroupRoot'])
    return p


class DockerConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__('localhost', timeout=0.2)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')
        require(struct.unpack('3i', self.sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1] == 0)


def docker_get(path):
    require(path == '/containers/json' or re.fullmatch('/containers/[a-f0-9]{64}/json', path))
    connection = DockerConnection()
    try:
        connection.request('GET', path)
        response = connection.getresponse()
        require(response.status == 200)
        data = response.read(2 * 1024 ** 2 + 1)
        require(len(data) <= 2 * 1024 ** 2)
        return load_json(data)
    finally:
        connection.close()


def process_identity(pid):
    integer(pid)
    raw = read(f'/proc/{pid}/stat')
    tail = raw[raw.rfind(')') + 2:].split()
    require(len(tail) > 19)
    status = dict(line.split(':', 1) for line in read(f'/proc/{pid}/status').splitlines() if ':' in line)
    namespace = [int(x) for x in status['NSpid'].split()]
    require(namespace and namespace[0] == pid)
    cg = read(f'/proc/{pid}/cgroup').strip().splitlines()
    require(len(cg) == 1 and cg[0].startswith('0::/'))
    return {'pid': pid, 'ppid': int(tail[1]), 'startTicks': int(tail[19]),
            'uid': int(status['Uid'].split()[0]), 'namespacePids': namespace,
            'pidNamespace': os.readlink(f'/proc/{pid}/ns/pid'),
            'boot': read('/proc/sys/kernel/random/boot_id').strip(), 'cgroup': cg[0][3:]}


def dead(fd):
    return bool(select.select([fd], [], [], 0)[0])


def cgroup_limits(path):
    root = Path('/sys/fs/cgroup')
    at = root / path.lstrip('/')
    require(str(at.resolve()).startswith(str(root) + '/'))
    memory, pids, cpu = [], [], []
    while at != root:
        for name, values in (('memory.max', memory), ('pids.max', pids)):
            raw = read(at / name).strip()
            if raw != 'max':
                values.append(integer(int(raw)))
        quota, period = read(at / 'cpu.max').split()
        if quota != 'max':
            cpu.append(integer(int(quota)) * 1000000 // integer(int(period)))
        at = at.parent
    require(memory and pids and cpu)
    return min(memory), min(pids), min(cpu)


def mount(path):
    matches = []
    for line in read('/proc/self/mountinfo', 1024 ** 2).splitlines():
        left, right = line.split(' - ', 1)
        fields, after = left.split(), right.split()
        # Paths with escaped whitespace are deliberately unsupported.
        if fields[4] == str(path):
            matches.append((int(fields[0]), fields[2], after[0], after[1]))
    require(len(matches) == 1)
    return matches[0]


class Quota(ctypes.Structure):
    _fields_ = [(n, ctypes.c_uint64) for n in
                ('bhard', 'bsoft', 'space', 'ihard', 'isoft', 'inodes', 'btime', 'itime')] + [('valid', ctypes.c_uint32)]


def project_quota(path, project_id):
    _, device, fs, source = mount(path)
    require(fs in ('ext4', 'xfs') and source.startswith('/dev/'))
    block = os.stat(source)
    require(stat.S_ISBLK(block.st_mode) and f'{os.major(block.st_rdev)}:{os.minor(block.st_rdev)}' == device)
    native = Path('/sys/dev/block') / device
    require('/virtual/' not in str(native.resolve()) and not list((native / 'holders').iterdir()))
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        import fcntl
        attrs = bytearray(28)
        fcntl.ioctl(fd, 0x801c581f, attrs, True)
        xflags, _, _, actual_project, _ = struct.unpack('=IIIII8x', attrs)
        require(actual_project == project_id and xflags & 0x200)
    finally:
        os.close(fd)
    quota = Quota()
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.quotactl((0x800007 << 8) | 2, os.fsencode(source), project_id, ctypes.byref(quota)) == 0)
    return quota


def auth_mount(m, uid):
    path = Path(m['source'])
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and info.st_mode & 0o077 == 0
            and info.st_dev == m['device'] and info.st_ino == m['inode'] and mount(path)[0] == m['mountId'])
    quota = project_quota(path, m['projectId'])
    require(quota.bhard * 1024 == m['hardBytes'] and quota.space <= m['hardBytes'])
    space = os.statvfs(path)
    remaining = max(0, m['hardBytes'] - quota.space)
    require(space.f_bavail * space.f_frsize >= HEADROOM + remaining)
    return remaining


def workspace(policy, streaming, empty, external_remaining=0):
    w = policy['streamWorkspace' if streaming else 'fullWorkspace']
    path = Path(w['path'])
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o711
            and info.st_dev == w['device'] and info.st_ino == w['inode'])
    mid, device, fs, source = mount(path)
    require(mid == w['mountId'])
    space = os.statvfs(path)
    if streaming:
        require(fs == 'tmpfs' and space.f_blocks * space.f_frsize == TMPFS)
        require(space.f_bavail * space.f_frsize > 0)
    else:
        require(fs in ('ext4', 'xfs') and source.startswith('/dev/'))
        block = os.stat(source)
        require(stat.S_ISBLK(block.st_mode) and f'{os.major(block.st_rdev)}:{os.minor(block.st_rdev)}' == device)
        native = Path('/sys/dev/block') / device
        resolved = str(native.resolve())
        require('/virtual/' not in resolved and not list((native / 'holders').iterdir()))
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            import fcntl
            attrs = bytearray(28)
            fcntl.ioctl(fd, 0x801c581f, attrs, True)  # FS_IOC_FSGETXATTR
            xflags, _, _, project, _ = struct.unpack('=IIIII8x', attrs)
            require(project == w['projectId'] and xflags & 0x200)  # PROJINHERIT
        finally:
            os.close(fd)
        quota = Quota()
        libc = ctypes.CDLL(None, use_errno=True)
        require(libc.quotactl((0x800007 << 8) | 2, os.fsencode(source),
                              w['projectId'], ctypes.byref(quota)) == 0)
        require(quota.bhard * 1024 == WORK and quota.space <= WORK)
        if empty:
            # Directory metadata is native allocated usage, not a sparse-file
            # promise. The reviewed baseline must match exactly while empty.
            require(quota.space == w['baselineQuotaBytes'])
        require(space.f_bavail * space.f_frsize >= HEADROOM +
                (WORK if empty else max(0, WORK - quota.space)) + external_remaining)
    if empty:
        require(not list(path.iterdir()))
    return path


class Coordinator:
    def __init__(self):
        require(os.geteuid() == 0 and hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal'))
        private_directory(POLICY.parent)
        fd, identity = root_file(POLICY)
        try:
            data = os.read(fd, 256 * 1024 + 1)
            require(len(data) <= 256 * 1024)
            self.policy = validate_policy(load_json(data))
            self.policy_bytes = data
            self.policy_identity = (identity.st_dev, identity.st_ino)
        finally:
            os.close(fd)
        executable_source = Path('/usr/local/lib/urm-host-media/coordinator.py')
        require(Path(__file__).resolve() == executable_source)
        fd, _ = root_file(executable_source)
        try:
            code = os.read(fd, 1024 ** 2 + 1)
            require(len(code) <= 1024 ** 2
                    and hashlib.sha256(code).hexdigest() == self.policy['coordinatorSHA256'])
        finally:
            os.close(fd)
        private_directory(STATE)
        self.lock = threading.RLock()
        self.live = None
        self.completed = {}
        self.fenced = (STATE / 'active.json').exists()
        self.last_health = time.monotonic()
        self.stopping = False

    def policy_unchanged(self):
        fd, identity = root_file(POLICY)
        try:
            require((identity.st_dev, identity.st_ino) == self.policy_identity
                    and os.read(fd, 256 * 1024 + 1) == self.policy_bytes)
        finally:
            os.close(fd)

    def immutable(self, name, data):
        path = STATE / name
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            payload = encoded(data)
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        directory = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def event(self, op, state, facts=None):
        sequence = op['sequence'] + 1
        data = {'v': 1, 'id': op['id'], 'state': state, 'sequence': sequence,
                'peer': op['peer'], 'kind': op['kind'], 'policySHA256': hashlib.sha256(self.policy_bytes).hexdigest(),
                'previous': op['eventSHA256'], 'facts': facts}
        self.immutable(f"{op['id']}-{sequence:06d}.json", data)
        op.update(sequence=sequence, eventSHA256=digest(data), state=state)

    def inventory(self):
        observed = time.monotonic()
        self.policy_unchanged()
        p = self.policy
        require(read('/proc/sys/kernel/random/boot_id').strip() == p['bootId'])
        host_root = os.stat('/')
        require(host_root.st_dev == p['hostRoot']['device'] and host_root.st_ino == p['hostRoot']['inode']
                and mount('/')[0] == p['hostRoot']['mountId'])
        root_space = os.statvfs('/')
        require(root_space.f_bavail * root_space.f_frsize >= HEADROOM)
        running = docker_get('/containers/json')
        require(type(running) is list and {c['Id'] for c in running} == {c['id'] for c in p['containers']})
        memory_sum, pid_sum = p['memoryBytes'], p['pids']
        auth_remaining = {}
        host_cgroups = set()
        process_count = 0
        for c in p['containers']:
            native = docker_get(f"/containers/{c['id']}/json")
            require(native['Id'] == c['id'] and native['Image'] == c['image']
                    and native['State']['Running'] is True and native['State'].get('Restarting') is False
                    and native['State']['StartedAt'] == c['startedAt'] and native['State']['Pid'] == c['initPid'])
            if {'pipeline-staging', 'pipeline-production'} & set(c['covers']):
                environment = native['Config']['Env']
                require(type(environment) is list)
                parsed = {}
                for item in environment:
                    require(type(item) is str and '=' in item)
                    key, value = item.split('=', 1)
                    require(key not in parsed)
                    parsed[key] = value
                require(parsed.get('URM_HOST_RESOURCE_PROTOCOL') == 'isolated-v1'
                        and parsed.get('PROCESS_AUDIO_RUNTIME_PROFILE', 'hetzner') == 'hetzner')
                for role, project in (('pipeline-staging', 'urm-app-staging'), ('pipeline-production', 'urm-app')):
                    if role in c['covers']:
                        require(parsed.get('FIREBASE_PROJECT_ID') == project)
            require(str(native['Config']['User']) == str(c['uid'])
                    and not native['HostConfig']['Privileged']
                    and not native['HostConfig'].get('PidMode')
                    and native['HostConfig'].get('ReadonlyRootfs') is True
                    and native['HostConfig'].get('Tmpfs', {}) == c['tmpfs'])
            require(not native['HostConfig'].get('CapAdd')
                    and 'no-new-privileges:true' in native['HostConfig'].get('SecurityOpt', []))
            init = process_identity(native['State']['Pid'])
            require(init['cgroup'] == c['cgroup'] and init['uid'] == c['uid']
                    and init['startTicks'] == c['initStartTicks'] and init['pidNamespace'] == c['pidNamespace'])
            limits = cgroup_limits(c['cgroup'])
            require(limits == (c['memoryBytes'], c['pids'], c['cpuMicrosPerSecond']))
            config = native['HostConfig']
            require(config['Memory'] == c['memoryBytes'] and config['PidsLimit'] == c['pids'])
            require(config.get('NanoCpus') == c['cpuMicrosPerSecond'] * 1000)
            logs = config['LogConfig']
            require(logs['Type'] == 'json-file' and logs['Config'] == {
                'max-size': str(c['logMaxBytes']), 'max-file': str(c['logMaxFiles'])})
            mounts = native['Mounts']
            require(not any(m.get('Destination') in ('/var/run/docker.sock', '/sys/fs/cgroup') for m in mounts))
            for m in c['authMounts']:
                selected = [actual for actual in mounts if actual.get('Destination') == m['destination']]
                require(len(selected) == 1 and selected[0].get('Type') == 'bind'
                        and selected[0].get('Source') == m['source'] and selected[0].get('RW') is True)
                remaining = auth_mount(m, c['uid'])
                key = (m['device'], m['projectId'])
                require(key not in auth_remaining)  # no shared-project accounting ambiguity
                require(key != (p['fullWorkspace']['device'], p['fullWorkspace']['projectId']))
                auth_remaining[key] = remaining
            require(all(not m.get('RW') or m.get('Destination') == '/workspace/host-resource'
                        or (m.get('Type') == 'tmpfs' and m.get('Destination') in c['tmpfs'])
                        or any(m.get('Destination') == approved['destination'] for approved in c['authMounts'])
                        for m in mounts))
            for enabled, w in ((c['fullMount'], p['fullWorkspace']), (c['streamMount'], p['streamWorkspace'])):
                if enabled:
                    # One canonical root per container; streaming-only helper
                    # containers use the stream root, legacy apps the full root.
                    selected = [m for m in mounts if m.get('Destination') == '/workspace/host-resource']
                    require(len(selected) == 1 and selected[0].get('Type') == 'bind'
                            and selected[0].get('Source') == w['path'] and selected[0].get('RW') is True)
            memory_sum += c['memoryBytes']
            pid_sum += c['pids']
        # Account for every host userspace executable, including browsers/PO
        # outside containers. Unknown native workloads deny admission.
        for name in os.listdir('/proc'):
            if not name.isdigit():
                continue
            process_count += 1
            pid = int(name)
            try:
                executable = os.readlink(f'/proc/{pid}/exe')
                ident = process_identity(pid)
            except FileNotFoundError:
                continue  # exited or kernel thread; never a positive admission
            if any(ident['cgroup'] == c['cgroup'] or ident['cgroup'].startswith(c['cgroup'] + '/')
                   for c in p['containers']):
                continue
            if self.live and self.live.get('scope') and ident['cgroup'] == self.live['scope']['relative']:
                continue
            allowed = [h for h in p['hostProcesses'] if h['exe'] == executable and h['cgroup'] == ident['cgroup']]
            require(len(allowed) == 1)
            if ident['cgroup'] not in host_cgroups:
                host_memory, host_pids, _ = cgroup_limits(ident['cgroup'])
                memory_sum += host_memory
                pid_sum += host_pids
                host_cgroups.add(ident['cgroup'])
            fd = os.open(executable, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
            info = os.fstat(fd)
            try:
                require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
                        and info.st_mode & 0o022 == 0 and info.st_size <= 128 * 1024 ** 2)
                value = hashlib.sha256()
                while chunk := os.read(fd, 65536):
                    value.update(chunk)
                require(value.hexdigest() == allowed[0]['sha256'])
            finally:
                os.close(fd)
        mem = dict(line.split(':', 1) for line in read('/proc/meminfo').splitlines())
        total = int(mem['MemTotal'].split()[0]) * 1024
        available = int(mem['MemAvailable'].split()[0]) * 1024
        needed = p['memoryBytes']
        if self.live and self.live.get('scope'):
            used = int(read(self.scope_path(self.live) / 'memory.current'))
            require(used >= 0)
            needed = max(0, needed - used)
        require(memory_sum + p['hostMemoryHeadroomBytes'] <= total
                and available >= needed + p['hostMemoryHeadroomBytes'])
        require(root_space.f_bavail * root_space.f_frsize >= HEADROOM +
                sum(value for (device, _), value in auth_remaining.items() if device == host_root.st_dev))
        workspace(p, False, empty=False, external_remaining=
                  sum(value for (device, _), value in auth_remaining.items()
                      if device == p['fullWorkspace']['device']))
        require(pid_sum + p['hostPidHeadroom'] <= int(read('/proc/sys/kernel/pid_max')))
        require(process_count + p['pids'] + p['hostPidHeadroom'] <= int(read('/proc/sys/kernel/pid_max')))
        if self.live and self.live.get('scope'):
            path = self.scope_path(self.live)
            require(cgroup_limits(self.live['scope']['relative']) ==
                    (p['memoryBytes'], p['pids'], p['cpuMicrosPerSecond']))
            require(read(path / 'memory.swap.max').strip() == '0')
        require(time.monotonic() - observed <= 0.25)
        return observed

    def peer(self, credentials):
        pid, uid, _ = credentials
        identity = process_identity(pid)
        require(uid == identity['uid'])
        matches = [c for c in self.policy['containers'] if c['uid'] == uid and c['cgroup'] == identity['cgroup']]
        require(len(matches) == 1)
        return identity, matches[0]

    def same_peer(self, op, credentials, child=False):
        identity = process_identity(credentials[0])
        expected = op.get('child') if child else op['peer']
        require(expected is not None and identity == expected and credentials[1] == identity['uid'])
        require(not dead(op['childfd'] if child else op['peerfd']))

    def scope_path(self, op):
        scope = op['scope']
        info = os.stat(scope['path'], follow_symlinks=False)
        held = os.fstat(op['scopefd'])
        require((info.st_dev, info.st_ino) == scope['identity'] == (held.st_dev, held.st_ino))
        return Path(f"/proc/self/fd/{op['scopefd']}")

    def scope_empty(self, op):
        path = self.scope_path(op)
        events = dict(line.split() for line in read(path / 'cgroup.events').splitlines())
        return events.get('populated') == '0' and read(path / 'cgroup.procs').strip() == ''

    def stop_scope(self, op, wait=False):
        until = time.monotonic() + 3
        if op.get('scope') is None or op['state'] in ('closed', 'unstarted'):
            return
        # Native cgroup.kill is recursive and scoped by the original inode. It
        # cannot signal a reused PID or an independently named replacement scope.
        op['stopped'] = True
        # The watchdog and request thread share one issuance fence. An uncertain
        # kernel write is not retried; only retained-scope observations follow.
        with op['stopLock']:
            path = self.scope_path(op)
            if not op.get('killIssued') and not self.scope_empty(op):
                op['killIssued'] = True
                (path / 'cgroup.kill').write_text('1')
        if wait:
            while True:
                require(time.monotonic() < until)
                if self.scope_empty(op) and (op.get('child') is None or dead(op['childfd'])):
                    require(time.monotonic() < until)
                    return
                time.sleep(0.025)

    def public(self, op):
        if op['state'] in ('closed', 'unstarted'):
            require(op.get('released') is True)
        value = {'v': 1, 'id': op['id'], 'state': op['state'], 'peerBound': True}
        if op['state'] in ('reserved', 'enrolled'):
            value['directory'] = f"/workspace/host-resource/{op['id']}"
        if op['state'] == 'closed':
            value['groupAbsent'] = True
            if op.get('killIssued'):
                value['descendantsStopped'] = True
        if op['state'] in ('closed', 'unstarted'):
            value['receiptHash'] = op['eventSHA256']
        return value

    def handle(self, request, credentials):
        require(type(request) is dict and type(request.get('v')) is int and request['v'] == 1)
        action = request.get('action')
        keys = {'v', 'action', 'id'}
        if action == 'reserve': keys.add('kind')
        if action == 'enroll': keys.add('childPid')
        exact(request, keys)
        require(type(request['id']) is str and str(uuid.UUID(request['id'])) == request['id'])
        with self.lock:
            if action == 'reserve':
                require(not self.fenced and self.live is None and len(self.completed) < 64
                        and request['kind'] in KINDS)
                # A spent operation ID can never reserve again.
                require(not list(STATE.glob(request['id'] + '-*.json')))
                self.inventory()
                identity, container = self.peer(credentials)
                streaming = request['kind'] == 'acquisition'
                require(container['streamMount' if streaming else 'fullMount'])
                base = workspace(self.policy, streaming, empty=True)
                root = Path(self.policy['operationCgroupRoot'])
                private_directory(root)
                require(not read(root / 'cgroup.procs').strip())
                require({'cpu', 'memory', 'pids'} <= set(read(root / 'cgroup.subtree_control').split()))
                fd = os.pidfd_open(identity['pid'], 0)
                require(process_identity(identity['pid']) == identity and not dead(fd))
                op = {'id': request['id'], 'kind': request['kind'], 'peer': identity,
                      'peerfd': fd, 'sequence': 0, 'eventSHA256': None,
                      'state': 'intent', 'scope': None, 'child': None,
                      'stopLock': threading.Lock(),
                      'childrenAtReserve': read(f"/proc/{identity['pid']}/task/{identity['pid']}/children").split()}
                # Persist intent BEFORE mkdir/cgroup/chown. Failure thereafter is
                # a retained fence, not a finally-unlock.
                self.immutable('active.json', {'v': 1, 'id': op['id'], 'peer': identity})
                self.live, self.fenced = op, True
                self.event(op, 'intent')
                directory = base / op['id']
                directory.mkdir(mode=0o700)
                os.chown(directory, identity['uid'], identity['uid'])
                op['directoryfd'] = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
                scope = root / op['id']
                scope.mkdir(mode=0o700)
                op['scopefd'] = os.open(scope, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
                info = os.fstat(op['scopefd'])
                op['scope'] = {'path': str(scope), 'identity': (info.st_dev, info.st_ino),
                               'relative': '/' + str(scope.relative_to('/sys/fs/cgroup'))}
                (scope / 'memory.max').write_text(str(self.policy['memoryBytes']))
                (scope / 'memory.swap.max').write_text('0')
                (scope / 'pids.max').write_text(str(self.policy['pids']))
                (scope / 'cpu.max').write_text(f"{self.policy['cpuMicrosPerSecond']} 1000000")
                self.event(op, 'reserved', {'directoryDevice': directory.stat().st_dev,
                                          'directoryInode': directory.stat().st_ino})
                sampled = self.inventory()
                workspace(self.policy, streaming, empty=False)
                require(not op.get('stopped') and time.monotonic() - sampled <= 0.25)
                self.last_health = time.monotonic()
                return self.public(op)
            op = self.live if self.live and self.live['id'] == request['id'] else self.completed.get(request['id'])
            require(op is not None and request['id'] == op['id'])
            self.same_peer(op, credentials, child=action == 'verify')
            if action == 'get':
                return self.public(op)
            if action == 'enroll':
                require(op['state'] == 'reserved' and op['child'] is None and not op.get('stopped'))
                sampled = self.inventory()
                integer(request['childPid'])
                children = read(f"/proc/{op['peer']['pid']}/task/{op['peer']['pid']}/children").split()
                matches = []
                for child in children:
                    ident = process_identity(int(child))
                    if ident['namespacePids'][-1] == request['childPid']:
                        matches.append(ident)
                require(len(matches) == 1)
                child = matches[0]
                require(child['ppid'] == op['peer']['pid'] and child['uid'] == op['peer']['uid']
                        and child['cgroup'] == op['peer']['cgroup']
                        and str(child['pid']) not in op['childrenAtReserve'])
                require(read(f"/proc/{child['pid']}/task/{child['pid']}/children").strip() == '')
                fd = os.pidfd_open(child['pid'], 0)
                require(process_identity(child['pid']) == child and not dead(fd))
                op.update(child=child, childfd=fd)
                self.event(op, 'enrolling', {'child': child})
                require(time.monotonic() - sampled <= 0.25 and not op.get('stopped'))
                (self.scope_path(op) / 'cgroup.procs').write_text(str(child['pid']))
                moved = process_identity(child['pid'])
                require(moved == {**child, 'cgroup': op['scope']['relative']} and not dead(fd))
                op['child'] = moved
                self.event(op, 'enrolled', {'child': moved})
                require(not op.get('stopped') and time.monotonic() - self.last_health <= 0.5)
                return self.public(op)
            if action == 'verify':
                require(op['state'] == 'enrolled' and not op.get('stopped'))
                sampled = self.inventory()
                workspace(self.policy, op['kind'] == 'acquisition', empty=False)
                require(time.monotonic() - self.last_health <= 0.5 and time.monotonic() - sampled <= 0.25
                        and not op.get('stopped'))
                return self.public(op)
            if action == 'stop':
                self.stop_scope(op, wait=True)
                return self.public(op)
            if action == 'unstarted':
                require(op['state'] == 'reserved' and op['child'] is None
                        and read(f"/proc/{op['peer']['pid']}/task/{op['peer']['pid']}/children").split() == op['childrenAtReserve']
                        and self.scope_empty(op))
                self.event(op, 'unstarted', {'noEnrollmentAttempt': True})
                return self.release(op)
            if action == 'close':
                if op['state'] == 'closed': return self.public(op)
                require(op['state'] in ('enrolled', 'enrolling') and op['child'] is not None
                        and dead(op['childfd']) and self.scope_empty(op))
                self.event(op, 'closed', {'child': op['child'], 'pidfdDead': True,
                                         'groupAbsent': True, 'scope': op['scope'],
                                         'stopped': op.get('stopped', False),
                                         'descendantsStopped': bool(op.get('killIssued'))})
                return self.release(op)
            require(False)

    def release(self, op):
        # No cleanup deadline or fresh capacity/auth dependency. Operation files
        # must already be removed by their owner. Never delete unknown files.
        base = Path(self.policy['streamWorkspace' if op['kind'] == 'acquisition' else 'fullWorkspace']['path'])
        held = os.fstat(op['directoryfd'])
        current = os.stat(base / op['id'], follow_symlinks=False)
        require((held.st_dev, held.st_ino) == (current.st_dev, current.st_ino))
        (base / op['id']).rmdir()
        self.scope_path(op)
        Path(op['scope']['path']).rmdir()
        self.immutable(op['id'] + '-release.json', {'v': 1, 'id': op['id'],
                                                  'receiptSHA256': op['eventSHA256'], 'state': op['state']})
        require(load_json(read(STATE / 'active.json')) == {'v': 1, 'id': op['id'], 'peer': op['peer']})
        (STATE / 'active.json').unlink()
        directory = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
        self.fenced = False
        op['released'] = True
        # Retain original live pidfds/readback until daemon exit; no closed-ID
        # replacement or name reuse. A subsequent reserve retires this response.
        self.completed[op['id']] = op
        self.live = None
        return self.public(op)

    def monitor(self):
        while not self.stopping:
            started = time.monotonic()
            try:
                op = self.live
                if op and op['state'] in ('reserved', 'enrolling', 'enrolled'):
                    require(not dead(op['peerfd']))
                    self.inventory()
                    workspace(self.policy, op['kind'] == 'acquisition', empty=False)
                    require(time.monotonic() - started <= 0.25)
                self.last_health = time.monotonic()
            except Exception:
                with self.lock:
                    if self.live: self.stop_scope(self.live)
            time.sleep(max(0, 0.25 - (time.monotonic() - started)))

    def watchdog(self):
        while not self.stopping:
            if self.live and self.live['state'] in ('reserved', 'enrolling', 'enrolled') and time.monotonic() - self.last_health > 0.5:
                # Do not wait for a stalled resource read or admission lock.
                try: self.stop_scope(self.live)
                except Exception: pass  # uncertainty retains reservation
            time.sleep(0.05)

    def serve(self):
        socket_directory(SOCKET.parent)
        require(not SOCKET.exists())  # never unlink/adopt another daemon socket
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(SOCKET))
        os.chmod(SOCKET, 0o666)  # kernel peer policy, not caller Unix-group claims
        listener.listen(16)
        threading.Thread(target=self.monitor, daemon=True).start()
        threading.Thread(target=self.watchdog, daemon=True).start()
        while True:
            connection, _ = listener.accept()
            with connection:
                connection.settimeout(1)
                response = UNAVAILABLE
                try:
                    credentials = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    raw = bytearray()
                    while not raw.endswith(b'\n'):
                        part = connection.recv(min(4096, LIMIT + 1 - len(raw)))
                        require(part and len(raw) + len(part) <= LIMIT)
                        raw.extend(part)
                    require(raw.count(b'\n') == 1)
                    response = self.handle(load_json(raw.decode('utf-8', 'strict')), credentials)
                except Exception:
                    pass
                try: connection.sendall(encoded(response) + b'\n')
                except OSError: pass  # ACK uncertainty never replays a mutation


if __name__ == '__main__':
    Coordinator().serve()
