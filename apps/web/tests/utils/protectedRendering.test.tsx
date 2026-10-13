import { renderToStaticMarkup } from 'react-dom/server';
import AppLayout from '../../layout/AppLayout';

const replace = jest.fn();
const push = jest.fn();
const auth = { user: undefined, loading: true, logoutUser: jest.fn() };
jest.mock('next/router', () => ({ useRouter: () => ({ replace, push, asPath: '/admin/sermons' }) }));
jest.mock('../../context/user/UserContext', () => ({ __esModule: true, default: () => auth }));
jest.mock('../../layout/SidebarLayout', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../components/RequestUploadPrivalige', () => ({ __esModule: true, default: () => null }));

describe('protected initial rendering', () => {
  it('keeps private content gated without redirecting during server rendering', () => {
    const html = renderToStaticMarkup(
      <AppLayout>
        <p>Private sermon directory</p>
      </AppLayout>
    );
    expect(html).not.toContain('Private sermon directory');
    expect(html).toContain('progressbar');
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
