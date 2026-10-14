const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { dirname, join, resolve } = require('node:path');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { createServer } = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = resolve(__dirname, '../..');
const rootRequire = createRequire(join(root, 'package.json'));
const packageVersion = (loader, name) => {
  let directory = dirname(loader.resolve(name));
  for (;;) {
    try {
      const pkg = require(join(directory, 'package.json'));
      if (pkg.name === name) return pkg.version;
    } catch {}
    const next = dirname(directory);
    if (next === directory) throw new Error(`Missing package identity: ${name}`);
    directory = next;
  }
};

test('CloudEvents uses patched CommonJS UUID and preserves structured HTTP round trips', () => {
  const { CloudEvent, HTTP } = rootRequire('cloudevents');
  const loader = createRequire(rootRequire.resolve('cloudevents'));
  assert.equal(packageVersion(loader, 'uuid'), '11.1.1');
  const uuid = loader('uuid');
  const event = new CloudEvent({ type: 'local.dependency.contract', source: '/fixture', data: { retained: true } });
  assert.equal(uuid.validate(event.id), true);
  assert.equal(uuid.version(event.id), 4);
  const message = HTTP.structured(event);
  const restored = HTTP.toEvent(message);
  assert.equal(restored.id, event.id);
  assert.deepEqual(restored.data, { retained: true });
  assert.throws(() => uuid.v3('fixture', uuid.v3.DNS, new Uint8Array(8)), RangeError);
  assert.throws(() => uuid.v5('fixture', uuid.v5.DNS, new Uint8Array(8)), RangeError);
  assert.throws(() => uuid.v6({}, new Uint8Array(8)), RangeError);
});

test('actual Storage multipart implementation round trips XML through scoped patched FXP with a fake transport', async () => {
  const { TransferManager } = rootRequire('@google-cloud/storage');
  const loader = createRequire(rootRequire.resolve('@google-cloud/storage'));
  assert.equal(packageVersion(loader, 'fast-xml-parser'), '5.11.2');
  const { XMLParser, XMLBuilder } = loader('fast-xml-parser');
  const parser = new XMLParser();
  const escaped = new XMLBuilder({ commentPropName: '#comment', cdataPropName: '#cdata' }).build({
    root: { '#comment': '--><script>bad</script><!--', '#cdata': 'content]]><script>bad</script>' },
  });
  assert.ok(!escaped.includes('<script>bad</script><!--'));
  const directory = await mkdtemp(join(tmpdir(), 'urm-storage-xml-contract-'));
  try {
    const file = join(directory, 'fixture.bin');
    await writeFile(file, 'abcdefgh');
    const requests = [];
    const bucket = {
      name: 'fixture.invalid',
      storage: {
        apiEndpoint: 'https://storage.invalid',
        retryOptions: { maxRetries: 0, retryDelayMultiplier: 1, maxRetryDelay: 1, totalTimeout: 1 },
        authClient: {
          request: async (options) => {
            requests.push(options);
            if (options.url.endsWith('?uploads'))
              return {
                data: '<InitiateMultipartUploadResult><UploadId>owned-id</UploadId></InitiateMultipartUploadResult>',
                headers: {},
              };
            if (options.method === 'PUT')
              return {
                data: '',
                headers: { etag: `part-${new URL(options.url).searchParams.get('partNumber')}&<value>` },
              };
            assert.equal(options.method, 'POST'); // No abort/delete masked failure is accepted.
            assert.equal(typeof options.body, 'string');
            const parsed = parser.parse(options.body);
            assert.deepEqual(parsed.CompleteMultipartUpload.Part, [
              { PartNumber: 1, ETag: 'part-1&<value>' },
              { PartNumber: 2, ETag: 'part-2&<value>' },
              { PartNumber: 3, ETag: 'part-3&<value>' },
            ]);
            return { data: { complete: true }, headers: {} };
          },
        },
      },
    };
    const result = await new TransferManager(bucket).uploadFileInChunks(file, {
      chunkSizeBytes: 3,
      concurrencyLimit: 1,
      validation: false,
    });
    assert.deepEqual(result.data, { complete: true });
    assert.equal(requests.length, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function close(server) {
  if (server.listening) await new Promise((done) => server.close(done));
}
test(
  'get-uri uses patched FTP client and its secure passive-host default through a real loopback transfer',
  { timeout: 10000 },
  async () => {
    const loader = createRequire(rootRequire.resolve('get-uri'));
    assert.equal(packageVersion(loader, 'basic-ftp'), '6.2.3');
    const { Client } = loader('basic-ftp');
    const client = new Client();
    assert.equal(client.options.allowSeparateTransferHost, false);
    client.close();
    const sockets = new Set(),
      dataServers = [];
    const commands = [];
    const payload = 'loopback fixture';
    const server = createServer((control) => {
      sockets.add(control);
      control.on('close', () => sockets.delete(control));
      control.on('error', () => undefined);
      control.write('220 local fixture ready\r\n');
      let pending = '',
        dataConnection;
      control.on('data', (buffer) => {
        pending += buffer.toString('utf8');
        let line;
        while ((line = pending.indexOf('\r\n')) >= 0) {
          const command = pending.slice(0, line);
          pending = pending.slice(line + 2);
          commands.push(command.split(' ')[0]);
          void (async () => {
            if (command.startsWith('USER')) control.write('331 password required\r\n');
            else if (command.startsWith('PASS')) control.write('230 logged in\r\n');
            else if (command === 'FEAT') control.write('211-Features\r\n MLST type*;size*;modify*;\r\n211 End\r\n');
            else if (command.startsWith('MDTM') || command.startsWith('EPSV')) control.write('500 unsupported\r\n');
            else if (command === 'PASV') {
              const dataServer = createServer((socket) => {
                sockets.add(socket);
                socket.on('close', () => sockets.delete(socket));
              });
              dataServers.push(dataServer);
              const port = await listen(dataServer);
              dataConnection = once(dataServer, 'connection').then(([socket]) => socket);
              // A different passive IP must never be followed. Data is listening only at control-host 127.0.0.1.
              control.write(`227 Entering Passive Mode (127,0,0,2,${port >> 8},${port & 255})\r\n`);
            } else if (command.startsWith('LIST') || command.startsWith('MLSD') || command.startsWith('RETR')) {
              control.write('150 data follows\r\n');
              const data = await dataConnection;
              data.end(
                !command.startsWith('RETR') ? 'type=file;size=16;modify=20261014000000; fixture.txt\r\n' : payload,
                () => control.write('226 transfer complete\r\n')
              );
            } else if (command === 'QUIT') control.end('221 goodbye\r\n');
            else control.write('200 accepted\r\n');
          })().catch((error) => control.destroy(error));
        }
      });
    });
    try {
      const port = await listen(server);
      const { getUri } = rootRequire('get-uri');
      const stream = await getUri(new URL(`ftp://fixture:fixture@127.0.0.1:${port}/fixture.txt`));
      let received = '';
      for await (const chunk of stream) received += chunk.toString();
      assert.equal(received, payload);
      assert.ok(commands.includes('MLSD'));
      assert.ok(commands.includes('RETR'));
      assert.ok(commands.filter((command) => command === 'PASV').length >= 2);
    } finally {
      sockets.forEach((socket) => socket.destroy());
      await Promise.all(dataServers.map(close));
      await close(server);
    }
  }
);

test(
  'Functions Framework actually starts over CommonJS and serves the migrated dependencies',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'urm-framework-security-contract-'));
    const probe = createServer();
    const port = await listen(probe);
    await close(probe);
    let child;
    try {
      await writeFile(
        join(directory, 'index.js'),
        `const r = require('node:module').createRequire(${JSON.stringify(join(root, 'package.json'))});
const { CloudEvent } = r('cloudevents');
const { XMLParser } = r('fast-xml-parser');
exports.dependencyContract = (_req,res) => res.json({ id: new CloudEvent({type:'fixture',source:'/fixture'}).id, xml: new XMLParser().parse('<root>ok</root>').root });\n`
      );
      const main = join(dirname(rootRequire.resolve('@google-cloud/functions-framework')), 'main.js');
      child = spawn(
        process.execPath,
        [main, '--source', directory, '--target', 'dependencyContract', '--port', String(port)],
        {
          env: { PATH: process.env.PATH, NODE_ENV: 'test' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const started = Date.now();
      let response;
      while (Date.now() - started < 10000) {
        if (child.exitCode !== null) throw new Error(`Framework exited: ${output}`);
        try {
          response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) });
          if (response.ok) break;
        } catch {}
        await new Promise((done) => setTimeout(done, 50));
      }
      assert.equal(response?.status, 200, output);
      const value = await response.json();
      assert.equal(value.xml, 'ok');
      assert.equal(rootRequire('uuid').validate(value.id), true);
      assert.equal(packageVersion(rootRequire, '@google-cloud/logging-winston'), '7.3.0');
      assert.equal(typeof rootRequire('@google-cloud/logging-winston').LoggingWinston, 'function');
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'actual production audio Winston logger constructs, emits and flushes through LoggingWinston7 without network',
  { timeout: 15000 },
  async () => {
    const child = spawn(process.execPath, [join(__dirname, 'logging-winston-runtime.fixture.cjs')], {
      env: { PATH: process.env.PATH, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, `${errors}\n${output}`);
    const marker = output.split('\n').find((line) => line.startsWith('LOGGING_CONTRACT:'));
    assert.ok(marker, output);
    assert.deepEqual(JSON.parse(marker.slice('LOGGING_CONTRACT:'.length)), {
      applicationTransport: true,
      emitted: 3,
      severityLabelsContextStack: true,
      flushed: true,
      failurePropagated: true,
      networkAttempts: 0,
    });
  }
);

test(
  'an asynchronous production log delivery failure cannot crash the application or expose its error payload',
  { timeout: 15000 },
  async () => {
    const child = spawn(process.execPath, [join(__dirname, 'logging-winston-runtime.fixture.cjs'), '--failure'], {
      env: { PATH: process.env.PATH, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, `${errors}\n${output}`);
    const { LOG_DELIVERY_FAILURE_NOTICE } = require(join(root, 'apps/process-audio/dist/logDeliveryFailure.js'));
    assert.equal(errors, LOG_DELIVERY_FAILURE_NOTICE);
    assert.ok(!`${output}${errors}`.includes('SYNTHETIC_SECRET_MUST_NOT_LEAK'));
    assert.ok(!errors.includes('PRIVATE_CODE'));
    assert.ok(!errors.includes('PRIVATE_REQUEST'));
    const originalError = output.split('\n').find((line) => line.includes('fixture-business-error'));
    assert.equal(JSON.parse(originalError).level, 'error');
    assert.ok(output.includes('fixture-business-continued'));
    const marker = output.split('\n').find((line) => line.startsWith('LOGGING_FAILURE_CONTRACT:'));
    assert.deepEqual(JSON.parse(marker.slice('LOGGING_FAILURE_CONTRACT:'.length)), {
      businessResult: 'business-operation-completed',
      networkAttempts: 0,
      asyncFailureObserved: true,
    });
  }
);

test('logging fallback has a fixed safe payload, rate limit and at most one pending write', () => {
  const { createLogDeliveryFailureReporter, LOG_DELIVERY_FAILURE_NOTICE } = require(join(
    root,
    'apps/process-audio/dist/logDeliveryFailure.js'
  ));
  let now = 0;
  const writes = [],
    callbacks = [];
  const report = createLogDeliveryFailureReporter({
    now: () => now,
    writeNotice: (message, done) => {
      writes.push(message);
      callbacks.push(done);
    },
  });
  for (let i = 0; i < 1000; i++) report(new Error('PRIVATE_PAYLOAD'));
  assert.deepEqual(writes, [LOG_DELIVERY_FAILURE_NOTICE]);
  now = 60_000;
  report(); // No queue growth while the original stderr write is still pending.
  assert.equal(writes.length, 1);
  callbacks[0]();
  report();
  assert.equal(writes.length, 2);
  callbacks[1]();
  report();
  assert.equal(writes.length, 2);
  let failures = 0;
  const failedStderr = createLogDeliveryFailureReporter({
    now: () => now,
    writeNotice: () => {
      failures++;
      throw new Error('CLOSED_STDERR');
    },
  });
  assert.doesNotThrow(failedStderr);
  assert.doesNotThrow(failedStderr);
  assert.equal(failures, 1);
  now += 60_000;
  assert.doesNotThrow(failedStderr);
  assert.equal(failures, 2);
});
