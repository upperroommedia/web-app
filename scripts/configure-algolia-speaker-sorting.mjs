// Staging setup is one reviewed five-index plan. Production replicas are preserved
// in place; a production settings migration needs its own reviewed target policy.
import { main } from './configure-algolia-staging-search.mjs';
main().catch(() => {
  console.error('Use explicit --project, --app and --indices for the staging settings plan; --apply requires a private settings key. Production settings are outside this initializer.');
  process.exitCode = 1;
});
