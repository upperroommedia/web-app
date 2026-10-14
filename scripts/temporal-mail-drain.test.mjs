import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { legacyMailRequiresDrain } from './temporal-release-lib.mjs';
const vectors = JSON.parse(await readFile(new URL('./tests/fixtures/legacy-mail-drain.json', import.meta.url), 'utf8'));
for (const vector of vectors)
  test(vector.name, () => {
    assert.equal(legacyMailRequiresDrain(vector.delivery), vector.requiresDrain);
  });
