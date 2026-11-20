#!/usr/bin/env python3
"""Read-only host inventory, not an acquisition admission or capacity receipt.

Run on the existing Hetzner host. Deliberately omit container Env, commands,
credentials, request data and provider output. Missing enforcement is reported;
this script never changes containers, limits, mounts, files or reservations.
"""
import datetime
import json
import os
import subprocess


def command(arguments):
    return subprocess.check_output(arguments, timeout=15, text=True)


def inspect():
    identifiers = command(['docker', 'ps', '-q']).split()
    containers = json.loads(command(['docker', 'inspect', *identifiers])) if identifiers else []
    observed = []
    blockers = []
    for container in containers:
        name = container['Name']
        if not name.startswith('/process-audio-hetzner-'):
            continue
        config = container['HostConfig']
        logs = config.get('LogConfig') or {}
        options = logs.get('Config') or {}
        memory = config.get('Memory')
        if not isinstance(memory, int) or memory <= 0:
            blockers.append({'container': name, 'reason': 'memory_limit_missing'})
        if logs.get('Type') != 'json-file' or not options.get('max-size') or not options.get('max-file'):
            # Other drivers may be bounded externally; require separate proof.
            blockers.append({'container': name, 'reason': 'bounded_logs_not_proved'})
        mounts = [
            {'type': item['Type'], 'source': item['Source'],
             'destination': item['Destination'], 'rw': item['RW']}
            for item in container['Mounts']
        ]
        observed.append({
            'name': name, 'id': container['Id'],
            'startedAt': container['State']['StartedAt'],
            'memoryBytes': memory,
            'memoryReservationBytes': config.get('MemoryReservation'),
            'memorySwapBytes': config.get('MemorySwap'),
            'pidsLimit': config.get('PidsLimit'),
            'nanoCpus': config.get('NanoCpus'),
            # Only allowlisted logging options, never arbitrary driver fields.
            'logs': {'driver': logs.get('Type'), 'maxSize': options.get('max-size'),
                     'maxFiles': options.get('max-file')},
            'tmpfs': config.get('Tmpfs'), 'mounts': mounts,
        })
    if not observed:
        raise RuntimeError('Existing Hetzner containers were not found')
    memory = {}
    with open('/proc/meminfo', encoding='utf8') as source:
        for line in source:
            key, value = line.split(':', 1)
            if key in ('MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'):
                fields = value.split()
                if len(fields) != 2 or fields[1] != 'kB':
                    raise RuntimeError('Unexpected native memory observation')
                memory[key + 'Bytes'] = int(fields[0]) * 1024
    filesystem = os.statvfs('/')
    with open('/proc/sys/kernel/random/boot_id', encoding='utf8') as source:
        boot_id = source.read().strip()
    return {
        'schemaVersion': 1,
        'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'mode': 'read_only_inventory',
        'bootId': boot_id,
        'memory': memory,
        'physicalRoot': {'device': os.stat('/').st_dev,
                         'totalBytes': filesystem.f_blocks * filesystem.f_frsize,
                         'availableBytes': filesystem.f_bavail * filesystem.f_frsize},
        'containers': observed,
        'observedBlockers': blockers,
        'unproved': ['shared_physical_reservation_bind', 'combined_host_memory_reserve',
                     'host_browser_and_canary_resources', 'competing_root_writers',
                     'bounded_acquisition_tmpfs', 'native_watchdog_and_drain'],
        # This observation is deliberately never accepted as authorization.
        'activationAuthorized': False,
    }


if __name__ == '__main__':
    print(json.dumps(inspect(), indent=2))
