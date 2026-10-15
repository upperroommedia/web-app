import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let pathname = '/admin/activity';
let count = 0;
let admin = true;
jest.mock('next/router', () => ({ useRouter: () => ({ pathname }) }));
// Preserve forwarded anchor semantics; the browser suite verifies real Next.js SPA navigation.
jest.mock('next/link', () => ({
  __esModule: true,
  default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { passHref?: boolean }>(
    function TestLink({ passHref: _passHref, ...props }, ref) {
      return <a {...props} ref={ref} />;
    }
  ),
}));
jest.mock('next/image', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/UserAvatar', () => ({ __esModule: true, default: () => null }));
jest.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light', setTheme: jest.fn() }) }));
jest.mock('../hooks/useHydratedTheme', () => ({ useHydratedTheme: () => 'light' }));
jest.mock('@mui/material/useMediaQuery', () => ({ __esModule: true, default: () => false }));
jest.mock('../context/user/UserContext', () => ({
  __esModule: true,
  default: () => ({ user: { role: 'publisher', isAdmin: () => admin }, logoutUser: jest.fn() }),
}));
jest.mock('../hooks/useDurableJobs', () => ({
  useVisibleJobs: () => ({ jobs: Array.from({ length: count }), stale: false, error: null }),
}));
import SidebarLayout from '../layout/SidebarLayout';
function anchors() {
  const html = renderToStaticMarkup(<SidebarLayout>Page content</SidebarLayout>);
  return Array.from(html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g), ([match]) => match);
}
function namedLink(links: string[], name: string, href: string) {
  const matches = links.filter((link) => link.includes(`aria-label="${name}"`));
  expect(matches).toHaveLength(1);
  const link = matches[0];
  expect(link).toContain(`href="${href}"`);
  expect(link).not.toMatch(/<button\b|role="button"|<a\b[^>]*>[\s\S]*<a\b/);
  return link;
}
it.each([0, 1, 100])('keeps Activity a single named link with %i active jobs', (activeJobs) => {
  count = activeJobs;
  admin = true;
  pathname = '/admin/activity';
  const link = namedLink(anchors(), 'Activity', '/admin/activity');
  expect(link).toContain('Mui-selected');
  expect(link).toMatch(/aria-hidden="true"[^>]*>[\s\S]*MuiBadge/);
  if (activeJobs) expect(link).toContain(activeJobs >= 100 ? '100+' : `>${activeJobs}<`);
});
it('keeps upload selected and publisher navigation visible without admin destinations', () => {
  count = 0;
  admin = false;
  pathname = '/';
  const links = anchors();
  expect(namedLink(links, 'Upload Sermon', '/')).toContain('Mui-selected');
  namedLink(links, 'Activity', '/admin/activity');
  namedLink(links, 'Sermons', '/admin/sermons');
  namedLink(links, 'Series', '/admin/series');
  expect(links.some((link) => link.includes('href="/admin/users"'))).toBe(false);
});
it('renders admin destinations as named anchors without nested interactive buttons', () => {
  admin = true;
  pathname = '/admin/users';
  const links = anchors();
  for (const [name, path] of [
    ['Users', 'users'],
    ['Speakers', 'speakers'],
    ['Lists', 'lists'],
    ['Topics', 'topics'],
    ['Advanced', 'advanced'],
  ])
    namedLink(links, name, `/admin/${path}`);
  expect(namedLink(links, 'Users', '/admin/users')).toContain('Mui-selected');
});
