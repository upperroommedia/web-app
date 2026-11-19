import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getDatabase, type Database } from 'firebase-admin/database';
import {
  readRenderProfileSeal,
  withRenderProfileSnapshot,
} from '../../../process-audio/src/temporal/hetzner-render-profile';
import { CancelToken } from '../../../process-audio/src/CancelToken';
import {
  acquireYouTubeToStream,
  downloadYouTubeAudioToFile,
  YouTubeStreamProviderError,
  YouTubeStreamBoundaryError,
  type YouTubeAcquisitionStreamSink,
} from '../../../process-audio/src/processYouTubeUrl';

jest.mock('../../../process-audio/src/firebaseAdmin', () => ({ __esModule: true, default: {} }));
jest.mock('../../../process-audio/src/WinstonLogger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: logger, createLoggerWithContext: () => logger };
});
let directory: string, binary: string, app: App, database: Database;
const before = { ...process.env };
const receipt = {
  path: 'workflow-audio/sermon-test/aaaaaaaaaaaaaaaa/source-attempt.bin',
  generation: '123',
  bytes: 100,
  crc32c: 'AAAAAA==',
};
beforeAll(() => {
  app = initializeApp(
    { projectId: 'urm-app-staging', databaseURL: 'https://urm-app-staging-default-rtdb.firebaseio.com' },
    'stream-adapter-isolated'
  );
  database = getDatabase(app);
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'youtube-stream-adapter-'));
  const profile = join(directory, 'profile');
  await mkdir(join(profile, 'Default', 'Network'), { recursive: true });
  await writeFile(join(profile, 'Default', 'Cookies'), 'synthetic-cookie-db-fixture');
  process.env.NODE_ENV = 'development';
  process.env.YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS = 'false';
  process.env.PROCESS_AUDIO_IN_PROCESS_BROWSER_FALLBACK_ENABLED = 'true';
  process.env.YOUTUBE_BROWSER_FALLBACK_ENABLED = 'true';
  process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = profile;
  process.env.PROCESS_AUDIO_BROWSER_PROFILE_BROWSER = 'chromium';
  delete process.env.YOUTUBE_BROWSER_FALLBACK_URL;
  delete process.env.YOUTUBE_FINAL_BROWSER_FALLBACK_URL;
  process.env.YTDLP_EXTERNAL_DOWNLOADER = 'aria2c';
  binary = join(directory, 'fake-ytdlp');
  await writeFile(
    binary,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({format_id:'140',protocol:'https',duration:100,ext:'m4a',url:'https://media.invalid/private-fixture',formats:[{format_id:'140',protocol:'https',duration:100,ext:'m4a',acodec:'aac',vcodec:'none',url:'https://media.invalid/private-fixture'}]}));`,
    { mode: 0o700 }
  );
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external requests in source policy tests'));
});
afterEach(async () => {
  jest.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
  Object.assign(process.env, before);
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => {
  await deleteApp(app);
});
const acquire = (sink: YouTubeAcquisitionStreamSink, context = { requestId: 'stream-test' }) =>
  acquireYouTubeToStream(
    binary,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    join(directory, 'source'),
    new CancelToken(),
    () => undefined,
    database,
    context,
    sink
  );

test('the existing public strategy sends a single original container to the stream sink', async () => {
  const execute = jest
    .fn<ReturnType<YouTubeAcquisitionStreamSink['execute']>, Parameters<YouTubeAcquisitionStreamSink['execute']>>()
    .mockResolvedValue(receipt);
  const context = { requestId: 'stream-test' };
  await expect(acquire({ execute }, context)).resolves.toEqual(receipt);
  expect(execute).toHaveBeenCalledTimes(1);
  const args = execute.mock.calls[0][0].args;
  expect(args.slice(args.indexOf('-o'), args.indexOf('-o') + 2)).toEqual(['-o', '-']);
  expect(args).toContain('--abort-on-unavailable-fragments');
  expect(args).not.toContain('-x');
  expect(args).not.toContain('aria2c');
  expect(args.slice(args.indexOf('-N'), args.indexOf('-N') + 2)).toEqual(['-N', '1']);
  expect(execute.mock.calls[0][0].authority).toBe('public_provider');
  expect(context).toMatchObject({ youtubeSuccessfulAcquisitionAuthority: 'public_provider' });
  expect(await readdir(directory)).not.toContain('source.m4a');
});
test('configured cookie-provider selection retains the original cookie argument and native downloader guard', async () => {
  process.env.YTDLP_USE_COOKIES_FOR_PUBLIC_VIDEOS = 'true';
  const execute = jest.fn(async (_input: Parameters<YouTubeAcquisitionStreamSink['execute']>[0]) => receipt);
  await expect(acquire({ execute })).resolves.toEqual(receipt);
  expect(execute.mock.calls[0][0].authority).toBe('cookie_provider');
  expect(execute.mock.calls[0][0].args).toContain('--cookies-from-browser');
  expect(execute.mock.calls[0][0].args).not.toContain('aria2c');
});
test('an uncertain upload cannot trigger a second provider attempt or authentication fallback', async () => {
  const execute = jest.fn(async () => {
    throw new Error('private transport URL or lost upload ACK');
  });
  await expect(acquire({ execute })).rejects.toBeInstanceOf(YouTubeStreamBoundaryError);
  expect(execute).toHaveBeenCalledTimes(1);
});
test('an invalid sink receipt fails closed before provider fallback', async () => {
  const execute = jest.fn(async () => ({ ...receipt, duration: 100 }));
  await expect(acquire({ execute })).rejects.toBeInstanceOf(YouTubeStreamBoundaryError);
  expect(execute).toHaveBeenCalledTimes(1);
});
test('unsupported external fallback configuration is rejected before attempting acquisition', async () => {
  process.env.YOUTUBE_FINAL_BROWSER_FALLBACK_URL = 'https://external.invalid';
  const execute = jest.fn(async () => receipt);
  await expect(acquire({ execute })).rejects.toThrow('YOUTUBE_STREAM_CONFIGURATION_UNSUPPORTED');
  expect(execute).not.toHaveBeenCalled();
});
test('missing local profile cannot silently hydrate a whole archived profile into root scratch', async () => {
  delete process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR;
  const execute = jest.fn(async () => receipt);
  await expect(acquire({ execute })).rejects.toThrow('YOUTUBE_STREAM_CONFIGURATION_UNSUPPORTED');
  expect(execute).not.toHaveBeenCalled();
});
test('a verified public provider failure keeps the existing resolved-format and cookie escalation ladder', async () => {
  let calls = 0;
  const execute = jest.fn(async (_input: Parameters<YouTubeAcquisitionStreamSink['execute']>[0]) => {
    if (++calls <= 2) throw new YouTubeStreamProviderError("ERROR: Sign in to confirm you're not a bot");
    return receipt;
  });
  await expect(acquire({ execute })).resolves.toEqual(receipt);
  expect(execute.mock.calls.map((call) => call[0].authority)).toEqual([
    'public_provider',
    'public_provider',
    'cookie_provider',
  ]);
  expect(execute.mock.calls[2][0].args).toContain('--cookies-from-browser');
});

test('configured in-process browser recovery streams the existing resolver result without metadata truncation', async () => {
  const execute = jest.fn(async (input: Parameters<YouTubeAcquisitionStreamSink['execute']>[0]) => {
    if (input.authority !== 'browser_fallback')
      throw new YouTubeStreamProviderError("ERROR: Sign in to confirm you're not a bot");
    return receipt;
  });
  await expect(acquire({ execute })).resolves.toEqual(receipt);
  expect(execute.mock.calls.map((call) => call[0].authority)).toEqual([
    'public_provider',
    'public_provider',
    'cookie_provider',
    'browser_fallback',
  ]);
  const browser = execute.mock.calls[3][0];
  expect(browser.args.slice(-3)).toEqual(['-f', 'matroska', 'pipe:1']);
  expect(browser.args).not.toContain('-t');
  expect(browser.args.at(-1)).toBe('pipe:1');
});
test('cancellation after a sink result cannot start another provider or format attempt', async () => {
  const execute = jest.fn(async (input: Parameters<YouTubeAcquisitionStreamSink['execute']>[0]) => {
    input.cancellation.cancel();
    return receipt;
  });
  await expect(acquire({ execute })).rejects.toBeInstanceOf(YouTubeStreamBoundaryError);
  expect(execute).toHaveBeenCalledTimes(1);
});

test('the existing legacy entrypoint still uses its original file and extraction path', async () => {
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv.slice(2); const output=args[args.indexOf('-o')+1].replace('%(ext)s','m4a'); fs.writeFileSync(output,'synthetic-file'); fs.writeFileSync(output+'.args',JSON.stringify(args));`,
    { mode: 0o700 }
  );
  const output = await downloadYouTubeAudioToFile(
    binary,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    join(directory, 'legacy-source'),
    new CancelToken(),
    () => undefined,
    database,
    { requestId: 'legacy-fixture' }
  );
  expect(output).toBe(join(directory, 'legacy-source.m4a'));
  const args = JSON.parse(await readFile(output + '.args', 'utf8'));
  expect(args).toContain('-x');
  expect(args[args.indexOf('-o') + 1]).toBe(join(directory, 'legacy-source.%(ext)s'));
});
test('an uncertain browser upload remains a boundary failure instead of a provider classification', async () => {
  const execute = jest.fn(async (input: Parameters<YouTubeAcquisitionStreamSink['execute']>[0]) => {
    if (input.authority !== 'browser_fallback')
      throw new YouTubeStreamProviderError("ERROR: Sign in to confirm you're not a bot");
    throw new Error('ambiguous object upload');
  });
  await expect(acquire({ execute })).rejects.toBeInstanceOf(YouTubeStreamBoundaryError);
  expect(execute.mock.calls.filter((call) => call[0].authority === 'browser_fallback')).toHaveLength(1);
});

test('non-DASH HLS stream attempts require every fragment and cannot certify a missing fragment', async () => {
  await writeFile(
    binary,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({format_id:'140',protocol:'m3u8_native',duration:100,ext:'m4a',formats:[{format_id:'140',protocol:'m3u8_native',duration:100,ext:'m4a',acodec:'aac',vcodec:'none'}]}));`,
    { mode: 0o700 }
  );
  const execute = jest.fn(async (input: Parameters<YouTubeAcquisitionStreamSink['execute']>[0]) => {
    if (!input.args.includes('--abort-on-unavailable-fragments')) return receipt;
    throw new YouTubeStreamProviderError('ERROR: fragment not found');
  });
  await expect(acquire({ execute })).rejects.toThrow();
  expect(execute.mock.calls.length).toBeGreaterThan(0);
  for (const [input] of execute.mock.calls) expect(input.args).toContain('--abort-on-unavailable-fragments');
});

test('the generation-bound file download ignores ambient extractor config and uses the owned database', async () => {
  const workspace = await realpath(directory);
  process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = join(workspace, 'profile');
  const target = join(directory, 'bound-source.%(ext)s');
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1];
const snapshot = ${JSON.stringify(join(workspace, 'extractor-profile'))};
if (!args.includes('--ignore-config') || !args.includes('--cookies-from-browser')
    || args[args.indexOf('--cookies-from-browser') + 1] !== 'chromium:' + snapshot) process.exit(3);
if (fs.readFileSync(snapshot + '/Cookies', 'utf8') !== 'synthetic-cookie-db-fixture') process.exit(4);
if (args.includes('-J') && args.includes('--skip-download')) {
  process.stdout.write(JSON.stringify({ duration: 100, formats: [
    {format_id: '140', protocol: 'https', ext: 'm4a', acodec: 'aac', vcodec: 'none'}
  ] }));
  process.exit(0);
}
if (args.indexOf('-o') < 0 || output !== ${JSON.stringify(target)}) process.exit(5);
fs.writeFileSync(output.replace('%(ext)s', 'm4a'), 'synthetic-file', { flag: 'wx' });
`,
    { mode: 0o700 }
  );
  const cancellation = new CancelToken();
  const seal = await readRenderProfileSeal(cancellation.signal);
  const output = await withRenderProfileSnapshot(workspace, seal, cancellation.signal, () =>
    downloadYouTubeAudioToFile(
      binary,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      join(directory, 'bound-source'),
      cancellation,
      () => undefined,
      database,
      { requestId: 'bound-fixture' }
    )
  );
  expect(output).toBe(join(directory, 'bound-source.m4a'));
});
