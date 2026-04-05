import fs from 'fs';
import path from 'path';

describe('functions-integrations index exports', () => {
  it('includes the Holy Week backfill callable in the integrations codebase entrypoint', () => {
    const entrypointPath = path.resolve(__dirname, '../../../../functions-integrations/src/index.ts');
    const entrypointSource = fs.readFileSync(entrypointPath, 'utf8');

    expect(entrypointSource).toContain("import backfillholyweeklists from '../../functions/src/backfillHolyWeekLists';");
    expect(entrypointSource).toContain('exports.backfillholyweeklists = backfillholyweeklists;');
  });
});
