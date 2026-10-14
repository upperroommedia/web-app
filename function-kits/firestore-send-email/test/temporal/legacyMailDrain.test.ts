import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { legacySmtpOutcomeUncertain } from '../../src/temporal/release';
const vectors = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../scripts/tests/fixtures/legacy-mail-drain.json'), 'utf8')
) as Array<{
  name: string;
  delivery?: Record<string, unknown>;
  uncertain: boolean;
}>;
for (const vector of vectors)
  test(vector.name, () => {
    expect(legacySmtpOutcomeUncertain(vector.delivery)).toBe(vector.uncertain);
  });
