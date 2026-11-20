import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { bounded, stopOwnedGroup } from './owned-media-process.mjs';

test('cleanup kills an owned descendant even after the detached leader has exited', async () => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const {spawn}=require('node:child_process');
    const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    process.stdout.write(String(descendant.pid),()=>{descendant.unref();process.exit(0);});
  `,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH } }
  );
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  try {
    assert.deepEqual(await bounded(exited), { code: 0, signal: null });
    assert.match(output, /^[0-9]+$/);
    // Positive baseline: the dead leader's group still exists before cleanup.
    process.kill(-child.pid, 0);
    await stopOwnedGroup({ child, exited });
    assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
  } finally {
    await stopOwnedGroup({ child, exited });
  }
});
