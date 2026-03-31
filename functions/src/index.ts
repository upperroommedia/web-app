// Deprecated compatibility entrypoint.
//
// Production deploys use the split Firebase codebases defined in firebase.json:
// - functions-core/src/index.ts
// - functions-media/src/index.ts
// - functions-image/src/index.ts
// - functions-integrations/src/index.ts
//
// Keep this file as a thin aggregate so any remaining test or emulator paths that
// resolve the legacy "functions" package still get the same exports without
// duplicating the function registry in two places.

import * as core from '../../functions-core/src/index';
import * as media from '../../functions-media/src/index';
import * as image from '../../functions-image/src/index';
import * as integrations from '../../functions-integrations/src/index';

Object.assign(exports, core, media, image, integrations);
