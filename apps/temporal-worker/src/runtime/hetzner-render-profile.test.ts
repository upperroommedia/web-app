import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeRenderProfileSnapshot,
  readRenderProfileSeal,
  withRenderProfileSnapshot,
} from '../../../process-audio/src/temporal/hetzner-render-profile';

test('the retained profile seal changes when SQLite WAL bytes change and rejects a replaced symlink', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'render-profile-fixture-')));
  const setting = process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR;
  process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = root;
  const profile = join(root, 'Default');
  const cookies = join(profile, 'Cookies');
  const signal = new AbortController().signal;
  try {
    await mkdir(profile);
    await writeFile(cookies, 'fixture only');
    const first = await readRenderProfileSeal(signal);
    expect(await readRenderProfileSeal(signal)).toBe(first);
    await writeFile(join(profile, 'Cookies-wal'), 'fixture WAL mutation');
    const changed = await readRenderProfileSeal(signal);
    expect(changed).not.toBe(first);
    await rm(cookies);
    await symlink(join(profile, 'Cookies-wal'), cookies);
    await expect(readRenderProfileSeal(signal)).rejects.toThrow('YOUTUBE_RENDER_PROFILE_UNCONFIRMED');
  } finally {
    if (setting === undefined) delete process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR;
    else process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = setting;
    await rm(root, { recursive: true, force: true });
  }
});

test.each(['checkpoint changes cookies', 'WAL appears after the database read'])(
  'rejects a mixed SQLite observation when %s',
  async (mutation) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'render-profile-race-')));
    const setting = process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR;
    process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = root;
    const profile = join(root, 'Default');
    const cookies = join(profile, 'Cookies');
    const wal = join(profile, 'Cookies-wal');
    const fs = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
    const stat = fs.lstat;
    try {
      await mkdir(profile);
      await writeFile(cookies, 'original fixture');
      if (mutation === 'checkpoint changes cookies') await writeFile(wal, 'original fixture WAL');
      let checkedCookies = 0;
      jest.spyOn(fs, 'lstat').mockImplementation((async (file, options) => {
        const observed = await stat(file, options);
        if (typeof file === 'string' && file.endsWith('/Cookies') && ++checkedCookies === 2) {
          if (mutation === 'checkpoint changes cookies') await writeFile(cookies, 'new fixture database bytes');
          else await writeFile(wal, 'new fixture WAL');
        }
        return observed;
      }) as typeof fs.lstat);
      await expect(readRenderProfileSeal(new AbortController().signal)).rejects.toThrow(
        'YOUTUBE_RENDER_PROFILE_UNCONFIRMED'
      );
      expect(checkedCookies).toBeGreaterThanOrEqual(2);
    } finally {
      jest.restoreAllMocks();
      if (setting === undefined) delete process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR;
      else process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = setting;
      await rm(root, { recursive: true, force: true });
    }
  }
);

test('fails closed if the named Chrome profile is replaced during the original database read', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'render-profile-replace-')));
  const previous = process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR;
  process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = root;
  const profile = join(root, 'Default');
  const replacement = join(root, 'Replacement');
  const fs = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  const lstat = fs.lstat;
  let swapped = false;
  try {
    await mkdir(profile);
    await mkdir(replacement);
    await writeFile(join(profile, 'Cookies'), 'original fixture');
    await writeFile(join(replacement, 'Cookies'), 'replacement fixture');
    jest.spyOn(fs, 'lstat').mockImplementation((async (file, options) => {
      const observed = await lstat(file, options);
      if (typeof file === 'string' && file.endsWith('/Cookies') && !swapped) {
        swapped = true;
        await rename(profile, join(root, 'Retired'));
        await rename(replacement, profile);
      }
      return observed;
    }) as typeof fs.lstat);
    await expect(readRenderProfileSeal(new AbortController().signal)).rejects.toThrow(
      'YOUTUBE_RENDER_PROFILE_UNCONFIRMED'
    );
    expect(swapped).toBe(true);
  } finally {
    jest.restoreAllMocks();
    if (previous === undefined) delete process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR;
    else process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('an owned extractor snapshot is private, uses one exact database and survives a shared Chrome write', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'render-snapshot-')));
  const setting = process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR;
  process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = root;
  const cookies = join(root, 'Default', 'Cookies');
  const signal = new AbortController().signal;
  try {
    await mkdir(join(root, 'Default'));
    await mkdir(join(root, 'Profile 1'));
    await writeFile(cookies, 'authorized fixture');
    await writeFile(join(root, 'Profile 1', 'Cookies'), 'other profile fixture');
    const seal = await readRenderProfileSeal(signal);
    let snapshot: string | undefined;
    await withRenderProfileSnapshot(root, seal, signal, async () => {
      snapshot = activeRenderProfileSnapshot()!.directory;
      expect(await readdir(snapshot)).toEqual(['Cookies']);
      expect((await stat(snapshot)).mode & 0o777).toBe(0o700);
      expect((await stat(join(snapshot, 'Cookies'))).mode & 0o777).toBe(0o400);
      await writeFile(cookies, 'refreshed fixture');
      expect(await readFile(join(snapshot, 'Cookies'), 'utf8')).toBe('authorized fixture');
    });
    expect(activeRenderProfileSnapshot()).toBeUndefined();
    await expect(stat(snapshot!)).rejects.toMatchObject({ code: 'ENOENT' });
    const retry = jest.fn();
    await expect(withRenderProfileSnapshot(root, seal, signal, retry)).rejects.toThrow(
      'YOUTUBE_RENDER_PROFILE_UNCONFIRMED'
    );
    expect(retry).not.toHaveBeenCalled();
    expect((await readdir(root)).sort()).toEqual(['Default', 'Profile 1']);
  } finally {
    if (setting === undefined) delete process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR;
    else process.env.PROCESS_AUDIO_BROWSER_PROFILE_DIR = setting;
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  'cookie provider',
  'muxed-only input',
  'local browser fallback',
  'public-only fallback',
  'sealed Chrome token',
  'foreign token',
])('the owned media-byte canary enforces its private snapshot with %s', async (route) => {
  const { runAuthenticatedYouTubeMediaByteCanary, withYouTubeCancellation } = await import(
    '../../../process-audio/src/processYouTubeUrl'
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), 'render-profile-canary-')));
  const muxedOnly = route === 'muxed-only input';
  const tokenRoute = route === 'sealed Chrome token' || route === 'foreign token';
  const { CancelToken } = await import('../../../process-audio/src/CancelToken');
  const { createContext } = await import('../../../process-audio/src/context');
  const cancellation = new CancelToken();
  const paths = {
    PROCESS_AUDIO_BROWSER_PROFILE_DIR: root,
    PROCESS_AUDIO_BROWSER_PROFILE_BROWSER: tokenRoute ? 'chrome' : 'chromium',
    PROCESS_AUDIO_RENDER_BROWSER_POT_CONTROL_DIR: root,
    PROCESS_AUDIO_YOUTUBE_AUTH_CANARY_URL: 'https://www.youtube.com/watch?v=abcdefghijk',
    YTDLP_POT_PROVIDER_BASE_URL: 'http://127.0.0.1:9',
    YTDLP_DIRECT_AUDIO_SELECTOR: '',
    YOUTUBE_BROWSER_FALLBACK_ENABLED: 'true',
    PROCESS_AUDIO_IN_PROCESS_BROWSER_FALLBACK_ENABLED: tokenRoute ? 'false' : 'true',
    PROCESS_AUDIO_BROWSER_FALLBACK_STRATEGY: route === 'public-only fallback' ? 'public_only' : 'session_backed',
    YOUTUBE_FINAL_BROWSER_FALLBACK_URL: 'https://unowned.example.invalid',
  };
  const previous = Object.fromEntries(Object.keys(paths).map((name) => [name, process.env[name]]));
  Object.assign(process.env, paths);
  const signal = cancellation.signal;
  const tmp = await import('../../../process-audio/src/utils');
  const ffmpeg = join(root, 'ffmpeg-fixture.cjs');
  const ffmpegPath = jest.spyOn(tmp, 'getFFmpegPath').mockReturnValue(ffmpeg);
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (url === 'https://api.ipify.org' || url === 'https://api6.ipify.org') return new Response('', { status: 503 });
    throw new Error('unexpected external route in profile fixture');
  });
  try {
    await mkdir(join(root, 'Default'));
    await mkdir(join(root, 'Profile 1'));
    await writeFile(join(root, 'Default', 'Cookies'), 'owned database fixture');
    await writeFile(join(root, 'Profile 1', 'Cookies'), 'other database fixture');
    const extractor = join(root, 'extractor.cjs');
    const invocations = join(root, 'extractor-invocations');
    await writeFile(
      extractor,
      `#!/usr/bin/env node
const { appendFileSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(invocations)}, args.includes('-J') ? 'resolve\\n' : 'cookie\\n');
if (!args.includes('--ignore-config') || !args.includes('--cookies-from-browser')) process.exit(2);
const account = args[args.indexOf('--cookies-from-browser') + 1];
const expected = ${JSON.stringify(join(root, 'extractor-profile'))};
if (account !== ${JSON.stringify(
        paths.PROCESS_AUDIO_BROWSER_PROFILE_BROWSER
      )} + ':' + expected || readdirSync(expected).join(',') !== 'Cookies') process.exit(3);
if (readFileSync(join(expected, 'Cookies'), 'utf8') !== 'owned database fixture') process.exit(4);
if (args.includes('-J')) {
  if (!args.includes('--skip-download')) process.exit(6);
  console.log(JSON.stringify({ formats: [{ vcodec: 'none', url: 'https://fixture.googlevideo.com/audio' }] }));
  process.exit(0);
}
const withToken = args.some((arg) => arg.includes('po_token=mweb.gvs+' + 'a'.repeat(120)));
if (${tokenRoute} && !withToken) {
  console.error('HTTP Error 403: unable to download video data');
  process.exit(7);
}
if (${muxedOnly}) {
  const selector = args[args.indexOf('-f') + 1];
  if (selector !== 'ba[ext=m4a]/ba[ext=webm]/ba/b[acodec!=none]' || !args.includes('-x')) {
    console.error('Requested format is not available');
    process.exit(8);
  }
}
if ((${JSON.stringify(
        route
      )} !== 'cookie provider' && !${muxedOnly} && !withToken) || !args.includes('--download-sections')) process.exit(7);
const output = args[args.indexOf('-o') + 1];
const outputName = withToken ? 'cookie-provider-browser-token' : 'cookie-provider';
if (args.indexOf('-o') < 0 || basename(output) !== outputName + '.%(ext)s'
    || !basename(dirname(output)).startsWith('youtube-auth-byte-canary-')) process.exit(5);
writeFileSync(join(dirname(output), outputName + '.fixture'), Buffer.alloc(128), { flag: 'wx' });
`,
      { mode: 0o700 }
    );
    await writeFile(
      ffmpeg,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const { basename, dirname } = require('node:path');
const args = process.argv.slice(2);
const file = args.at(-1);
if (${JSON.stringify(
        route
      )} !== 'local browser fallback' || args[args.indexOf('-i') + 1] !== 'https://fixture.googlevideo.com/audio' ||
    args[args.indexOf('-t') + 1] !== '3' || basename(file) !== 'browser-fallback.m4a' ||
    !basename(dirname(file)).startsWith('youtube-auth-byte-canary-')) process.exit(2);
writeFileSync(file, Buffer.alloc(256), { flag: 'wx' });
`,
      { mode: 0o700 }
    );
    const seal = await readRenderProfileSeal(signal);
    const waiting = withRenderProfileSnapshot(root, seal, signal, () =>
      withYouTubeCancellation(cancellation, () =>
        runAuthenticatedYouTubeMediaByteCanary(extractor, {} as never, createContext('fixture', 'fixture'), true)
      )
    );
    if (tokenRoute) {
      let name: string | undefined;
      for (let attempt = 0; attempt < 100 && !name; attempt++) {
        name = (await readdir(root)).find((file) => /^pot-[a-f0-9]{32}\.sealed-pot\.request$/.test(file));
        if (!name) await new Promise((resolve) => setTimeout(resolve, 15));
      }
      if (!name) {
        cancellation.cancel();
        await waiting;
        throw new Error('Expected a snapshot-scoped broker request');
      }
      const digest = createHash('sha256').update('owned database fixture').digest('hex');
      const request = join(root, name);
      expect(JSON.parse(await readFile(request, 'utf8'))).toEqual({ videoId: 'abcdefghijk', cookieDigest: digest });
      await rm(request);
      const receipt = { ok: true, videoId: 'abcdefghijk', cookieDigest: digest, poToken: 'a'.repeat(120) };
      if (route === 'foreign token') receipt.cookieDigest = 'f'.repeat(64);
      await writeFile(request.replace(/\.request$/, '.result'), JSON.stringify(receipt), { flag: 'wx' });
    }
    const report = await waiting;
    const bytes =
      route === 'cookie provider' || muxedOnly || route === 'sealed Chrome token'
        ? 128
        : route === 'local browser fallback'
        ? 256
        : 0;
    expect(report).toMatchObject({ scope: 'authenticated', succeeded: bytes > 0, bytesDownloaded: bytes });
    expect(await readFile(invocations, 'utf8')).toBe(
      route === 'local browser fallback'
        ? 'cookie\nresolve\n'
        : route === 'sealed Chrome token'
        ? 'cookie\ncookie\n'
        : 'cookie\n'
    );
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('unowned.example.invalid'), expect.anything());
  } finally {
    cancellation.cancel();
    fetch.mockRestore();
    ffmpegPath.mockRestore();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
