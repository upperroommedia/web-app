import { fork } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { captureHostOutcome, consumeHostOutcome } from '../../../process-audio/src/host/outcome';
import {
  MissingSermonDocumentError,
  ProcessAudioAlreadyRunningError,
  ProcessAudioCancelledError,
} from '../../../process-audio/src/processAudio';
import { getYouTubeFailureDisposition, type YouTubeAcquisitionEvidence } from '@upperroom/contracts/processAudioQueue';
jest.mock('../../../process-audio/src/instrument', () => ({
  Sentry: { startSpan: (_: unknown, run: () => unknown) => run() },
}));
jest.mock('../../../process-audio/src/WinstonLogger', () => {
  const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: logger, createLoggerWithContext: () => logger };
});
const id = '00000000-0000-4000-8000-000000000001';
test.each([
  new MissingSermonDocumentError('owned', 'sermons/owned'),
  new ProcessAudioAlreadyRunningError({ sermonId: 'owned', activeRequestId: 'original', lockAgeMs: 123 }),
  new ProcessAudioCancelledError(),
])('safe work outcome preserves original HTTP error class: %s', (error) => {
  const result = captureHostOutcome(id, undefined, error, { sermonId: 'owned', requestId: 'original' });
  expect(() =>
    consumeHostOutcome(
      JSON.parse(JSON.stringify(result)),
      id,
      { sermonId: 'owned', requestId: 'original' },
      'legacy-full'
    )
  ).toThrow(error);
  expect(JSON.stringify(result)).not.toContain('sermons/owned');
});
test.each(['post_live_archive_not_ready', 'cookie_session_stale_or_challenged', 'account_required_content'] as const)(
  'safe failure evidence preserves existing auth/archive/restricted disposition: %s',
  (failureClass) => {
    const evidence: YouTubeAcquisitionEvidence = {
      attemptedModes: ['public_provider', 'cookie_provider'],
      requiresAuthenticationRecovery: failureClass === 'cookie_session_stale_or_challenged',
      authenticatedFailureClass: failureClass,
      ...(failureClass === 'account_required_content' ? { terminalFailureClass: failureClass } : {}),
    };
    const error = Object.assign(new Error('CONTROLLED_PRIVATE_DIAGNOSTIC'), { youtubeAcquisitionEvidence: evidence });
    const saved = captureHostOutcome(id, undefined, error, { requestId: 'original' });
    expect(JSON.stringify(saved)).not.toContain('CONTROLLED_PRIVATE_DIAGNOSTIC');
    let actual: unknown;
    try {
      consumeHostOutcome(saved, id, { requestId: 'original' }, 'legacy-full');
    } catch (caught) {
      actual = caught;
    }
    expect(actual).toBeInstanceOf(Error);
    expect(getYouTubeFailureDisposition((actual as typeof error).youtubeAcquisitionEvidence)).toEqual(
      getYouTubeFailureDisposition(evidence)
    );
  }
);
test('invalid work output never updates the original parent context', () => {
  const ctx = { sermonId: 'owned', requestId: 'original' };
  expect(() =>
    consumeHostOutcome(
      {
        v: 1,
        id,
        kind: 'success',
        value: { alreadyProcessed: true, privateDiagnostic: 'CONTROLLED' },
        flags: { youtubeCookieRefreshSucceeded: true },
      },
      id,
      ctx,
      'legacy-full'
    )
  ).toThrow('HOST_WORK_OUTCOME_UNCONFIRMED');
  expect(ctx).toEqual({ sermonId: 'owned', requestId: 'original' });
});
test('actual source isolated helper stays inert; malformed IPC cannot open Firebase/provider work', async () => {
  const child = fork(resolve(__dirname, '../../../../scripts/integration/fixtures/host-isolated-current.cjs'), [], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: [],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production' },
  });
  const messages: unknown[] = [];
  child.on('message', (message) => messages.push(message));
  const closed = once(child, 'close');
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  try {
    expect((await once(child, 'message'))[0]).toEqual({ fixture: 'inert-ready', installed: true });
    await new Promise((done) => setTimeout(done, 40));
    expect(exited).toBe(false);
    child.send({ authorized: true, directory: '/tmp/foreign', kind: 'legacy-full' });
    expect(await closed).toEqual([1, null]);
    expect(messages).toEqual([{ fixture: 'inert-ready', installed: true }]);
  } finally {
    if (!exited) child.kill('SIGKILL');
    await closed;
  }
});
