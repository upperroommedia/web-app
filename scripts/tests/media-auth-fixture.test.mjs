// Exercises the actual Playwright fixture runner, without a browser, server or SDK.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(resolve(root, 'apps/web/package.json'));
const playwright = require.resolve('@playwright/test/cli');
const helper = resolve(root, 'apps/web/tests/helpers/mediaTest.ts');
const workerHelper = resolve(root, 'apps/web/tests/helpers/mediaAuthenticatedTest.ts');

test(
  'actual fixture runner orders setup and cleanup, fences failed auth, and separates setup from body deadlines',
  { timeout: 70000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'urm-auth-fixture-'));
    let child, completion;
    const terminate = () => {
      if (child?.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }
    };
    context.signal.addEventListener('abort', terminate, { once: true });
    try {
      const events = join(directory, 'events.jsonl'),
        report = join(directory, 'report.json');
      await writeFile(
        join(directory, 'playwright.config.ts'),
        `export default {testDir:'.',testMatch:'contract.spec.ts',timeout:300,workers:1,retries:0,reporter:[['json',{outputFile:${JSON.stringify(
          report
        )}}]]};`
      );
      const bundleSource = await readFile(resolve(root, 'apps/web/shared/bundleConfigs.ts'), 'utf8');
      const catalogPrefixes = [...bundleSource.matchAll(/cacheKeyPrefix: '([^']+)'/g)].map((match) => match[1]);
      assert.equal(catalogPrefixes.length, 6);
      await writeFile(
        join(directory, 'contract.spec.ts'),
        `
import {appendFileSync} from 'node:fs';
import {createMediaTest} from ${JSON.stringify(helper)};
import {withoutMediaCatalogCache} from ${JSON.stringify(workerHelper)};
const event=(name:string)=>appendFileSync(${JSON.stringify(events)},JSON.stringify({name,time:Date.now()})+'\\n');
const sleep=(ms:number)=>new Promise(done=>setTimeout(done,ms));
function variant(name:string, mode:'success'|'auth-failure'|'body-timeout'|'setup-timeout') {
 const test=createMediaTest<void>(async (_page,usePrepared)=>{
  event(name+':prepare');
  try {await sleep(mode==='success'?450:0);await usePrepared({callbackPath:'/',data:undefined});}
  finally {event(name+':cleanup');}
 },{
  installBackend:async()=>{event(name+':backend')},
  login:async()=>{event(name+':login');if(mode==='auth-failure')throw Error('deliberate authentication failure');if(mode==='setup-timeout')await new Promise(()=>{});},
  ready:async()=>{event(name+':ready')},
 }).extend({page:async ({},use)=>{await use({} as import('@playwright/test').Page);}});
 test(name,async ({authenticatedMedia},testInfo)=>{
  event(name+':body');
  if(testInfo.timeout!==300)throw Error('Functional timeout changed');
  if(mode==='body-timeout')await sleep(1000);
  else await sleep(100);
  event(name+':body-done');
 });
}
variant('independent-budget','success');
variant('failed-auth','auth-failure');
variant('functional-budget','body-timeout');
variant('setup-budget','setup-timeout');
const inherited=createMediaTest<void>(async (_page,usePrepared)=>{await usePrepared({callbackPath:'/',data:undefined});},{installBackend:async()=>{},login:async()=>{},ready:async()=>{}}).extend({page:async ({},use)=>{await use({} as import('@playwright/test').Page);}});
const alias=inherited.extend({});
inherited('worker auth state excludes only real catalog keys',async()=>{
 const prefixes=${JSON.stringify(catalogPrefixes)};
 const catalog=prefixes.flatMap((prefix:string)=>[{name:prefix+'-bundle-timestamp',value:'opaque-catalog'},{name:'cached-'+prefix,value:'opaque-catalog'}]);
 const auth={name:'firebase:authUser:fixture',value:'opaque-sdk-state'};
 const indexedDB=[{name:'opaque-sdk-database',version:1,stores:[]}];
 const cookies=[{name:'fixture',value:'opaque-cookie',domain:'127.0.0.1',path:'/',expires:-1,httpOnly:false,secure:false,sameSite:'Lax' as const}];
 const state={cookies,origins:[{origin:'http://127.0.0.1:3004',localStorage:[auth,...catalog,{name:'unrelated',value:'retained'}],indexedDB},{origin:'http://127.0.0.1:9100',localStorage:catalog}]};
 const result=withoutMediaCatalogCache(state);
 if(JSON.stringify(result.origins[0].localStorage)!==JSON.stringify([auth,{name:'unrelated',value:'retained'}]))throw Error('Catalog cache survived or SDK auth state changed');
 if(result.cookies!==cookies||result.origins[0].indexedDB!==indexedDB||result.origins[1]!==state.origins[1])throw Error('Noncatalog SDK storage changed');
 if(state.origins[0].localStorage.length!==14)throw Error('Original snapshot mutated');
});
inherited.describe('original longer functional suite',()=>{
 inherited.setTimeout(30000);
 alias('aliased original30s',async ({authenticatedMedia},info)=>{if(info.timeout!==30000)throw Error('Inherited functional budget changed');event('inherited:body');});
});

`
      );
      child = spawn(process.execPath, [playwright, 'test', '--config', join(directory, 'playwright.config.ts')], {
        cwd: root,
        env: { ...process.env, CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let output = '';
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk) => {
          output += chunk;
          if (output.length > 2 * 1024 * 1024) terminate();
        });
      completion = new Promise((done, reject) => {
        child.once('error', reject);
        child.once('close', done);
      });
      const code = await completion;
      assert.equal(code, 1, `Expected deliberately failing fixture cases: ${output.slice(-3000)}`);
      const result = JSON.parse(await readFile(report, 'utf8'));
      const flatten = (suites) => suites.flatMap((suite) => [...suite.specs, ...flatten(suite.suites ?? [])]);
      const specs = flatten(result.suites);
      assert.equal(specs.length, 6, output.slice(-3000));
      const byTitle = new Map(specs.map((spec) => [spec.title, spec.tests[0].results[0]]));
      assert.equal(byTitle.get('independent-budget').status, 'passed');
      assert.equal(byTitle.get('worker auth state excludes only real catalog keys').status, 'passed');
      assert.equal(byTitle.get('aliased original30s').status, 'passed');
      assert.equal(byTitle.get('failed-auth').status, 'failed');
      assert.match(byTitle.get('failed-auth').error.message, /deliberate authentication failure/);
      assert.equal(byTitle.get('functional-budget').status, 'timedOut');
      assert.match(byTitle.get('functional-budget').error.message, /300ms/);
      assert.equal(byTitle.get('setup-budget').status, 'timedOut');
      context.diagnostic(
        'Actual Playwright runner: independent setup/body budgets and inherited30s passed; deliberate auth failure/body300ms/setup30000ms failures observed. No browser launched.'
      );
      assert.match(byTitle.get('setup-budget').error.message, /Fixture "authenticatedMedia" timeout of 30000ms/);
      const records = (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
      const names = records.map((record) => record.name);
      assert.deepEqual(
        names.filter((name) => name.startsWith('independent-budget:')),
        [
          'independent-budget:backend',
          'independent-budget:prepare',
          'independent-budget:login',
          'independent-budget:ready',
          'independent-budget:body',
          'independent-budget:body-done',
          'independent-budget:cleanup',
        ]
      );
      assert(!names.includes('failed-auth:ready'));
      assert(!names.includes('failed-auth:body'));
      assert(names.includes('failed-auth:cleanup'));
      assert(names.includes('functional-budget:body'));
      assert(!names.includes('functional-budget:body-done'));
      assert(names.includes('functional-budget:cleanup'));
      assert(!names.includes('setup-budget:body'));
      const start = records.find((record) => record.name === 'independent-budget:prepare').time;
      const end = records.find((record) => record.name === 'independent-budget:body-done').time;
      assert(end - start > 500, 'Setup and functional body really exceeded the body-only300ms budget together');
    } finally {
      context.signal.removeEventListener('abort', terminate);
      terminate();
      if (completion) {
        let timer;
        try {
          await Promise.race([
            completion.catch(() => {}),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Fixture contract process group did not close')), 2000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
);
