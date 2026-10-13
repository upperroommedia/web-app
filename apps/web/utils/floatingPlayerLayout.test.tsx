import { renderToStaticMarkup } from 'react-dom/server';
import AppLayout from '../layout/AppLayout';

jest.mock('../components/RequestUploadPrivalige', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/UserAvatar', () => ({ __esModule: true, default: () => null }));
jest.mock('next/router', () => ({ useRouter: () => ({ asPath: '/admin/sermons', replace: jest.fn() }) }));
jest.mock('../context/user/UserContext', () => ({
  __esModule: true,
  default: () => ({ user: { canUpload: () => true }, loading: false, logoutUser: jest.fn() }),
}));
jest.mock('../layout/SidebarLayout', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

it('reserves the visible floating controls on the scrolling element independently of playback readiness', () => {
  const html = renderToStaticMarkup(
    <AppLayout>
      <div>Last sermon row</div>
    </AppLayout>
  );
  const scrollElement = html.match(/<div[^>]*data-testid="main-content-scroll"[^>]*>/)?.[0];
  expect(scrollElement).toBeDefined();
  const className = scrollElement?.match(/class="[^"]*\b(css-[\w-]+)"/)?.[1];
  expect(className).toBeDefined();
  const declarations = html.match(new RegExp(`\\.${className}\\{([^}]+)\\}`))?.[1];
  expect(declarations).toContain(
    'padding-bottom:calc(var(--floating-player-offset, 0px) + env(safe-area-inset-bottom, 0px))'
  );
  expect(declarations).toContain(
    'scroll-padding-bottom:calc(var(--floating-player-offset, 0px) + env(safe-area-inset-bottom, 0px))'
  );
  expect(declarations).toContain('overflow:auto');
});
