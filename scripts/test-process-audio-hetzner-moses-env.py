"""Exercise the deploy script's production preflight with synthetic inputs and no remote operations."""

import base64
import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


source = Path(__file__).with_name('deploy-process-audio-hetzner.sh').read_text()
renderer = source[source.index('append_moses_guest_pilot_env() {'):
                  source.index('\n}\n', source.index('write_env_file() {')) + 3]
candidate_preflight = source.split("<<'REMOTE_PRODUCTION_PREFLIGHT'\n", 1)[1].split(
    '\nREMOTE_PRODUCTION_PREFLIGHT\n', 1
)[0]
origin = 'https://moses-guest.upperroommedia.org'
account = 'moses-guest-task-invoker@urm-app.iam.gserviceaccount.com'
audience = 'https://yt-worker.upperroommedia.org/process-audio'
token = base64.urlsafe_b64encode(bytes(range(32))).rstrip(b'=').decode()
pilot = {
    'MOSES_GUEST_AUDIO_ENABLED': 'true',
    'MOSES_GUEST_AUDIO_ORIGIN': origin,
    'MOSES_GUEST_AUDIO_VIDEO_IDS': 'aBcDe-FgH_0',
    'MOSES_GUEST_AUDIO_TOKEN_VERSION': '12',
    'PROCESS_AUDIO_MOSES_GUEST_PILOT_SERMON_ID': 'planned_sermon',
    'PROCESS_AUDIO_MOSES_GUEST_PILOT_NOT_BEFORE': '2024-02-29T12:34:56.000Z',
    'PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_SUBJECT': '123456789012345678901',
}


class MosesEnvTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        (self.root / 'env').mkdir()
        gcloud = self.root / 'gcloud'
        gcloud.write_text("""#!/bin/sh
set -eu
case "$5" in
    --secret=MOSES_GUEST_AUDIO_TOKEN)
        test "$#" = 7
        test "$1 $2 $3 $4 $5 $6" = "secrets versions access 12 --secret=MOSES_GUEST_AUDIO_TOKEN --project=urm-app"
        case "$7" in --out-file="$WORK_DIR"/*/token) ;; *) exit 1 ;; esac
        echo requested >> "$WORK_DIR/accesses"
        test "${FAKE_DENY:-false}" = false
        printf %s "$FAKE_TOKEN" > "${7#--out-file=}"
        ;;
    *) test "$1 $2 $3 $4" = 'secrets versions access latest'; printf fixture ;;
esac
""")
        gcloud.chmod(0o700)

    def render(self, settings, target='production', profile='youtube', token_bytes=token, deny=False, hostname=None):
        env = {
            'PATH': f'{self.root}{os.pathsep}{os.defpath}', 'WORK_DIR': str(self.root),
            'TARGET_ENV': target, 'SMOKE_PROFILE': profile, 'RELEASE_SHA': 'fixture',
            'production_hostname': hostname or 'yt-worker.upperroommedia.org',
            'staging_hostname': 'yt-worker-staging.upperroommedia.org',
            'public_canary_url': 'fixture', 'auth_canary_url': 'fixture',
            'FAKE_TOKEN': token_bytes, 'FAKE_DENY': str(deny).lower(),
            **{f'PROCESS_AUDIO_{key}': 'fixture' for key in (
                'YTDLP_VERSION', 'FFMPEG_VERSION', 'DENO_VERSION', 'BGUTIL_VERSION', 'BGUTIL_IMAGE')},
            **settings,
        }
        worker = 'staging' if target == 'staging' else 'production'
        access_log = self.root / 'accesses'
        if access_log.exists():
            access_log.unlink()
        result = subprocess.run(['bash', '-eu', '-c', renderer + f'\nwrite_env_file {worker}'],
                                env=env, capture_output=True, text=True)
        self.assertNotIn(token, result.stdout + result.stderr)
        path = self.root / 'env' / f'process-audio-{worker}.env'
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertFalse(list(self.root.glob('*/token')))
        return result.returncode, path.read_text(), access_log.exists()

    def test_unarmed_and_staging(self):
        for settings, target in (({}, 'production'), ({**pilot, 'MOSES_GUEST_AUDIO_ENABLED': 'false'}, 'production'),
                                 (pilot, 'staging')):
            code, rendered, access = self.render(settings, target)
            self.assertEqual(code, 0)
            self.assertNotIn('MOSES_', rendered)
            self.assertFalse(access)
            self.assertEqual('PROCESS_AUDIO_RECOVER_ORPHANED_STATE_ON_STARTUP=false' in rendered,
                             target == 'production')

    def test_armed_production(self):
        code, rendered, access = self.render(pilot)
        self.assertEqual(code, 0)
        self.assertTrue(access)
        values = dict(line.split('=', 1) for line in rendered.splitlines() if 'MOSES_' in line)
        self.assertEqual(values, {
            **{key: value for key, value in pilot.items() if key != 'MOSES_GUEST_AUDIO_TOKEN_VERSION'},
            'MOSES_GUEST_AUDIO_TOKEN': token, 'PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_AUDIENCE': audience,
            'PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_SERVICE_ACCOUNT': account,
        })

    def test_recovery_is_separately_configured_and_exactly_scoped(self):
        recovery = {
            'PROCESS_AUDIO_MOSES_RECOVERY_ENABLED': 'true',
            'PROCESS_AUDIO_MOSES_RECOVERY_VIDEO_ID': pilot['MOSES_GUEST_AUDIO_VIDEO_IDS'],
            'PROCESS_AUDIO_MOSES_RECOVERY_SERMON_ID': 'existing_sermon',
            'PROCESS_AUDIO_MOSES_RECOVERY_REQUEST_VERSION': 'a' * 16,
            'PROCESS_AUDIO_MOSES_RECOVERY_CUSTODY_SHA256': 'b' * 64,
        }
        settings = {key: value for key, value in pilot.items() if 'GUEST_PILOT' not in key}
        code, rendered, access = self.render({**settings, **recovery})
        self.assertEqual(code, 0)
        self.assertTrue(access)
        self.assertNotIn('GUEST_PILOT', rendered)
        for key, value in recovery.items():
            self.assertIn(f'{key}={value}\n', rendered)
        for key, value in (
            ('MOSES_GUEST_AUDIO_ENABLED', 'false'),
            ('PROCESS_AUDIO_MOSES_RECOVERY_VIDEO_ID', 'f' * 11),
            ('PROCESS_AUDIO_MOSES_RECOVERY_REQUEST_VERSION', 'a' * 15),
            ('PROCESS_AUDIO_MOSES_RECOVERY_CUSTODY_SHA256', 'b' * 63),
        ):
            self.assert_rejected(self.render({**settings, **recovery, key: value}), access=False)

    def test_backlog_cohort_has_an_exact_production_release_and_video_scope(self):
        def encode(rows, *, schema=1, compact=True):
            body = json.dumps({'schema': schema, 'rows': rows}, separators=(',', ':') if compact else None)
            return base64.urlsafe_b64encode(body.encode()).rstrip(b'=').decode()

        rows = [
            {'ref': 'failed-01', 'kind': 'failed_request', 'sermonId': 'failed_original',
             'videoId': 'aBcDe-FgH_0', 'requestVersion': 'a' * 16},
            {'ref': 'missing-01', 'kind': 'missing_admission', 'sermonId': 'missing_original',
             'videoId': 'aaaaaaaaaaa'},
        ]
        settings = {key: value for key, value in pilot.items() if 'GUEST_PILOT' not in key and key != 'MOSES_GUEST_AUDIO_VIDEO_IDS'}
        scope = {
            'PROCESS_AUDIO_MOSES_RECOVERY_ENABLED': 'true',
            'PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL': encode(rows),
            'PROCESS_AUDIO_MOSES_BACKLOG_RELEASE_SHA': 'b' * 40,
            'RELEASE_SHA': 'b' * 40,
        }
        code, rendered, access = self.render({**settings, **scope})
        self.assertEqual(code, 0)
        self.assertTrue(access)
        self.assertIn('MOSES_GUEST_AUDIO_VIDEO_IDS=aBcDe-FgH_0,aaaaaaaaaaa\n', rendered)
        self.assertNotIn('GUEST_PILOT', rendered)
        self.assertNotIn('MOSES_GUEST_AUDIO_SECTION_ENABLED', rendered)
        code, rendered, access = self.render({**settings, **scope, 'MOSES_GUEST_AUDIO_SECTION_ENABLED': 'true'})
        self.assertEqual(code, 0)
        self.assertTrue(access)
        self.assertIn('MOSES_GUEST_AUDIO_SECTION_ENABLED=true\n', rendered)
        self.assert_rejected(self.render({**pilot, 'MOSES_GUEST_AUDIO_SECTION_ENABLED': 'true'}), access=False)
        for override in (
            {'RELEASE_SHA': 'c' * 40},
            {'PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL': encode([rows[0], rows[0]])},
            {'PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL': encode([{**rows[0], 'requestVersion': None}])},
            {'PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL': encode([{**rows[0], 'ref': 'r' * 49}])},
            {'PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL': encode([{**rows[0], 'sermonId': '__youtube_auth_recovery__'}])},
            {'PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL': encode(rows, schema=True)},
            {'PROCESS_AUDIO_MOSES_RECOVERY_COHORT_B64URL': encode(rows, compact=False)},
            {'MOSES_GUEST_AUDIO_VIDEO_IDS': 'c' * 11},
        ):
            self.assert_rejected(self.render({**settings, **scope, **override}), access=False)

    def test_reject_invalid_scope_or_input_before_secret_access(self):
        for key, value in (
            ('MOSES_GUEST_AUDIO_ENABLED', 'yes'), ('MOSES_GUEST_AUDIO_ORIGIN', origin + '/'),
            ('MOSES_GUEST_AUDIO_ORIGIN', 'https://yt-worker-staging.upperroommedia.org'),
            ('MOSES_GUEST_AUDIO_VIDEO_IDS', 'aBcDe-FgH_0,bbbbbbbbbbb'),
            ('PROCESS_AUDIO_MOSES_GUEST_PILOT_SERMON_ID', 'sermon\nOTHER=true'),
            ('PROCESS_AUDIO_MOSES_GUEST_PILOT_NOT_BEFORE', '2023-02-29T12:34:56.000Z'),
            ('PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_SUBJECT', '0' * 21),
            ('PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_SERVICE_ACCOUNT', 'other@example.org'),
            ('PROCESS_AUDIO_MOSES_GUEST_TASK_OIDC_AUDIENCE', audience + '/'),
            ('MOSES_GUEST_AUDIO_TOKEN_VERSION', 'latest'), ('MOSES_GUEST_AUDIO_TOKEN_VERSION', '012'),
            ('MOSES_GUEST_AUDIO_TOKEN', 'ignored-plaintext'),
        ):
            with self.subTest(key=key, value=value):
                self.assert_rejected(self.render({**pilot, key: value}), access=False)
        for options in ({'target': 'all'}, {'profile': 'soundcloud'}, {'hostname': 'yt-worker-staging.upperroommedia.org'}):
            self.assert_rejected(self.render(pilot, **options), access=False)

    def test_reject_unavailable_and_noncanonical_secret(self):
        for bad in (token + '\n', token + '=', 'A' * 42 + 'B', ''):
            self.assert_rejected(self.render(pilot, token_bytes=bad), access=True)
        self.assert_rejected(self.render(pilot, deny=True), access=True)

    def assert_rejected(self, output, access):
        code, rendered, fetched = output
        self.assertNotEqual(code, 0)
        self.assertNotIn('MOSES_', rendered)
        self.assertEqual(fetched, access)

    def test_production_requires_exact_candidate_before_mutations(self):
        self.assertLess(source.index(candidate_preflight), source.index('setup-process-audio-hetzner-desktop-bridge.sh'))
        context = 'a' * 64
        image = 'sha256:' + 'b' * 64
        proof = self.root / 'state' / 'deploy-candidates' / context
        proof.mkdir(parents=True)
        docker = self.root / 'docker'
        docker.write_text('#!/bin/sh\nset -eu\ntest "$1 $2" = "image inspect"\nprintf "%s\\n" "$FAKE_IMAGE"\n')
        docker.chmod(0o700)

        def verify(actual_image=image):
            return subprocess.run(
                ['bash', '-c', candidate_preflight, 'fixture', str(self.root), context, 'youtube'],
                env={'PATH': f'{self.root}{os.pathsep}{os.defpath}', 'FAKE_IMAGE': actual_image},
                capture_output=True, text=True,
            )

        self.assertNotEqual(verify().returncode, 0)
        for name, value in (
            ('validated', 'fixture'), ('validated-smoke-profile', 'soundcloud'),
            ('context-sha256', context), ('image-id', image),
        ):
            (proof / name).write_text(value + '\n')
        self.assertNotEqual(verify().returncode, 0)
        (proof / 'validated-smoke-profile').write_text('youtube\n')
        self.assertNotEqual(verify('sha256:' + 'c' * 64).returncode, 0)
        self.assertEqual(verify().returncode, 0)


if __name__ == '__main__':
    unittest.main()
