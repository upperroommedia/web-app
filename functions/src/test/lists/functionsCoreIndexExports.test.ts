import fs from 'fs';
import path from 'path';

describe('functions-core index exports', () => {
  it('includes list overflow admin callables in the core codebase entrypoint', () => {
    const entrypointPath = path.resolve(__dirname, '../../../../functions-core/src/index.ts');
    const entrypointSource = fs.readFileSync(entrypointPath, 'utf8');

    expect(entrypointSource).toContain(
      "import getlistoverflowchain from '../../functions/src/getListOverflowChain';"
    );
    expect(entrypointSource).toContain(
      "import getlistpublisheddrift from '../../functions/src/getListPublishedDrift';"
    );
    expect(entrypointSource).toContain(
      "import backfillsermonsubsplashstatus from '../../functions/src/backfillSermonSubsplashStatus';"
    );
    expect(entrypointSource).toContain(
      "import { createHolyWeekBundle } from '../../functions/src/createHolyWeekBundle';"
    );
    expect(entrypointSource).toContain(
      "import marklistoverflowlink from '../../functions/src/markListOverflowLink';"
    );
    expect(entrypointSource).toContain('holyWeekListOnWrite');
    expect(entrypointSource).toContain(
      "import reorderlistitems from '../../functions/src/reorderListItems';"
    );
    expect(entrypointSource).toContain(
      "import resolvelistpublisheddrift from '../../functions/src/resolveListPublishedDrift';"
    );
    expect(entrypointSource).toContain('exports.getlistoverflowchain = getlistoverflowchain;');
    expect(entrypointSource).toContain('exports.getlistpublisheddrift = getlistpublisheddrift;');
    expect(entrypointSource).toContain('exports.backfillsermonsubsplashstatus = backfillsermonsubsplashstatus;');
    expect(entrypointSource).toContain('exports.createholyweekbundle = createHolyWeekBundle;');
    expect(entrypointSource).toContain('exports.holyweeklistonwrite = holyWeekListOnWrite;');
    expect(entrypointSource).toContain('exports.marklistoverflowlink = marklistoverflowlink;');
    expect(entrypointSource).toContain('exports.reorderlistitems = reorderlistitems;');
    expect(entrypointSource).toContain('exports.resolvelistpublisheddrift = resolvelistpublisheddrift;');
  });
});
