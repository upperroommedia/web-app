import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import imageLoader from '../loader.js';

const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
after(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

test('private Firebase images keep their download authorization and encoded path', () => {
  const src = 'https://firebasestorage.googleapis.com/v0/b/project.appspot.com/o/images%2Fphoto%2520name.jpg?alt=media&token=download-token';
  const output = imageLoader({ src, width: 640, quality: 80 });
  const operations = JSON.parse(new URL(output, 'https://example.com').searchParams.get('operations'));
  assert.equal(operations[0].url, src);
  assert.deepEqual(operations[1], { operation: 'resize', width: 640 });
});

test('local static images bypass the processing service', () => {
  assert.equal(imageLoader({ src: '/URM_icon.png', width: 64 }), '/URM_icon.png');
});
