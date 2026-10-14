import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import SearchAttribution from './SearchAttribution';

test('the official search wordmark is visible, named accessibly, and links to Algolia', () => {
  const html = renderToStaticMarkup(<SearchAttribution />);
  expect(html).toContain('aria-label="Search by Algolia"');
  expect(html).toContain('href="https://www.algolia.com/"');
  expect(html).toContain('alt="Search by Algolia"');
  expect(html).toContain('width="143"');
  expect(html).not.toContain('display:none');
  const asset = readFileSync(join(__dirname, '../../public/search-by-algolia.svg'), 'utf8');
  expect(asset).toContain('viewBox="0 0 572 64"');
  expect(asset.match(/<path/g)?.length).toBe(2);
});
