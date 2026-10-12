const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { app } = require('../lib/index.js');
const { isPublicAddress, coerceStringToBoolean } = require('../lib/utils.js');
const { boolean } = require('superstruct');
let server, base;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => new Promise(resolve => server.close(resolve)));
const request = operations => fetch(`${base}/process?operations=${encodeURIComponent(JSON.stringify(operations))}`);
test('existing JSON URL API produces a resized webp with requested quality/headers', async () => {
  const response = await request([{ operation: 'input', type: 'create', width: 100, height: 50, background: 'red' }, { operation: 'resize', width: 20 }, { operation: 'output', format: 'webp', quality: 75 }]);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/webp');
  const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  assert.equal(metadata.width, 20); assert.equal(metadata.height, 10);
  assert.match(response.headers.get('cache-control'), /s-maxage=86400/);
});
test('path API still supports transformations', async () => {
  const response = await fetch(`${base}/process/input~type:create~width:12~height:8/grayscale/output~format:png`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
});
test('malformed and invalid operations return 400 using the four-argument error handler', async () => {
  for (const operations of [[], {}, [null], [{ operation: 'resize', width: 10 }], [{ operation: 'constructor' }]]) {
    assert.equal((await request(operations)).status, 400);
  }
  assert.equal((await fetch(`${base}/process?operations=%7B`)).status, 400);
  assert.equal((await fetch(`${base}/process?operations=a&operations=b`)).status, 400);
});
test('encoded percent signs in source names are not double-decoded', async () => {
  const response = await request([{ operation: 'input', type: 'url', url: 'http://127.0.0.1/image%25.png' }, { operation: 'output', format: 'png' }]);
  assert.equal(response.status, 400); assert.match(await response.text(), /HTTPS/);
});
test('oversized images and long operation pipelines fail early', async () => {
  assert.equal((await request([{ operation: 'input', type: 'create', width: 20000, height: 20000 }, { operation: 'output', format: 'png' }])).status, 400);
  assert.equal((await request([{ operation: 'input', type: 'create', width: 10, height: 10 }, ...Array(32).fill({ operation: 'flip' }), { operation: 'output', format: 'png' }])).status, 400);
});
test('private and metadata addresses cannot be fetched', async () => {
  for (const address of ['127.0.0.1', '10.1.1.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(address), false);
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  const response = await request([{ operation: 'input', type: 'url', url: 'https://169.254.169.254/metadata' }, { operation: 'output', format: 'png' }]);
  assert.equal(response.status, 400);
});
test('boolean flags parse 1 and 0 correctly', () => { assert.equal(coerceStringToBoolean().create('1'), true); assert.equal(coerceStringToBoolean().create('0'), false); });
test('a one-dimensional upscale is bounded using the source aspect ratio', async () => {
  const response = await request([{ operation: 'input', type: 'create', width: 10, height: 100 }, { operation: 'resize', width: 16000 }, { operation: 'output', format: 'png' }]);
  assert.equal(response.status, 400); assert.match(await response.text(), /size limit/);
});
test('text operation lazy-loads its modern renderer and produces an image', async () => {
  const response = await request([{ operation: 'input', type: 'create', width: 200, height: 200 }, { operation: 'text', value: 'Hello', font: '16px sans-serif' }, { operation: 'output', format: 'png' }]);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
});
test('affine output size is rejected before native materialization', async () => {
  const response = await request([{ operation: 'input', type: 'create', width: 100, height: 100 },
    { operation: 'affine', matrix: [200, 0, 0, 200] }, { operation: 'output', format: 'png' }]);
  assert.equal(response.status, 400); assert.match(await response.text(), /size limit/);
});
test('outside resize uses actual aspect-ratio bounds before allocating', async () => {
  const response = await request([{ operation: 'input', type: 'create', width: 10, height: 100 },
    { operation: 'resize', width: 16000, height: 1, fit: 'outside' }, { operation: 'output', format: 'png' }]);
  assert.equal(response.status, 400); assert.match(await response.text(), /size limit/);
});
test('affine singular matrices and excessive offsets are invalid requests', async () => {
  for (const options of [{ matrix: [1, 1, 1, 1] }, { matrix: [1, 0, 0, 1], odx: 1000000 }]) {
    const response = await request([{ operation: 'input', type: 'create', width: 10, height: 10 },
      { operation: 'affine', ...options }, { operation: 'output', format: 'png' }]);
    assert.equal(response.status, 400);
  }
});
test('small affine and rotated images retain their operation semantics', async () => {
  const response = await request([{ operation: 'input', type: 'create', width: 10, height: 20 },
    { operation: 'affine', matrix: [2, 0, 0, 2] }, { operation: 'rotate', angle: 90 }, { operation: 'output', format: 'png' }]);
  assert.equal(response.status, 200);
  const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  assert.equal(metadata.width, 40); assert.equal(metadata.height, 20);
});
test('oversized text and composite density fail before rendering or fetching', async () => {
  for (const operation of [{ operation: 'text', value: 'Hello', font: '100000px sans-serif' },
    { operation: 'text', value: 'x'.repeat(4097) }, { operation: 'text', value: 'Hello', padding: 1000000 },
    { operation: 'composite', input: 'https://example.com/image.svg', density: 1000000 }]) {
    const response = await request([{ operation: 'input', type: 'create', width: 10, height: 10 }, operation,
      { operation: 'output', format: 'png' }]);
    assert.equal(response.status, 400);
  }
});
test('rotate bounding box is checked without allocating a huge test input', async () => {
  const { assertRotatedDimensions, assertAffineDimensions } = require('../lib/operations/limits.js');
  assert.throws(() => assertRotatedDimensions(6000, 6000, 45), /size limit/);
  assert.doesNotThrow(() => assertRotatedDimensions(16384, 100, 90));
  assert.throws(() => assertAffineDimensions(100, 100, [Infinity, 0, 0, 1], []), /finite/);
});
