import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { useHydratedTheme } from '../hooks/useHydratedTheme';

function Page({ resolvedTheme }: { resolvedTheme?: string }) {
  const theme = useHydratedTheme(resolvedTheme);
  return createElement('main', { 'data-theme': theme }, 'Sign in to upload and manage sermons');
}

it.each(['light', 'dark', undefined])(
  'server HTML uses a deterministic theme with preference %s and preserves page content',
  (resolvedTheme) => {
    const html = renderToString(createElement(Page, { resolvedTheme }));
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('Sign in to upload and manage sermons');
  }
);
