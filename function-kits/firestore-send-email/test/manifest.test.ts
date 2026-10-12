import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

// Use the compiled entrypoint and actual Firebase SDK in a fresh process. Mocked
// queue tests cannot validate the deployment manifest's parameter expressions.
test('actual SDK manifest preserves and resolves MAIL_COLLECTION trigger expression', () => {
  const result = execFileSync(process.execPath, ['-e', `
    const kit = require('./lib/index.js');
    const endpoint = kit.processQueue.__endpoint;
    const document = endpoint.eventTrigger.eventFilterPathPatterns.document;
    console.log(JSON.stringify({cel: document.toCEL(), path: document.value(), retry: endpoint.eventTrigger.retry, secrets: endpoint.secretEnvironmentVariables}));
  `], {cwd: resolve(__dirname, '..'), env: {...process.env, MAIL_COLLECTION: 'mail', DATABASE: '(default)', LOCATION: 'us-central1', AUTH_TYPE: 'UsernamePassword'}, encoding: 'utf8'});
  const manifest = JSON.parse(result.trim());
  expect(manifest.cel).toBe('{{ params.MAIL_COLLECTION }}/{documentId}');
  expect(manifest.path).toBe('mail/{documentId}');
  expect(manifest.path).not.toContain('params.MAIL_COLLECTION');
  expect(manifest.retry).toBe(true);
  expect(manifest.secrets).toEqual([{key: 'SMTP_PASSWORD'}]);
});
