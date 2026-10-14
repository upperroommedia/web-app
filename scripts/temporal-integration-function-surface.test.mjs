import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import test from 'node:test';
const root = new URL('../', import.meta.url);
test('retired bulk tagging entry points cannot be deployed or invoked from application source', async () => {
  const index = await readFile(new URL('functions-integrations/src/index.ts', root), 'utf8');
  for (const name of ['tagitemsinlist', 'updatesubsplashtag']) assert.doesNotMatch(index, new RegExp(name, 'i'));
  for (const path of ['functions/src/Scrapers/tagItemsInList.ts', 'functions/src/Scrapers/updateSubsplashTag.ts'])
    await assert.rejects(access(new URL(path, root)), { code: 'ENOENT' });
  for (const name of ['createSoundCloudAuthSession', 'exchangeSoundCloudAuthCode'])
    assert.match(index, new RegExp(`exports\\.${name} = ${name};`));
});
