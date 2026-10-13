import { renderToStaticMarkup } from 'react-dom/server';
import { UserProvider } from '../../context/user/UserContext';

jest.mock('../../firebase/auth', () => ({ __esModule: true, default: {} }));
jest.mock('@sentry/nextjs', () => ({ setUser: jest.fn(), setTag: jest.fn(), setContext: jest.fn() }));

describe('public initial rendering', () => {
  it('renders public content while browser authentication is still unresolved', () => {
    const html = renderToStaticMarkup(
      <UserProvider>
        <main>
          <h1>Sign in to Upper Room Media</h1>
        </main>
      </UserProvider>
    );
    expect(html).toContain('<main>');
    expect(html).toContain('Sign in to Upper Room Media');
    expect(html).not.toContain('token');
  });
});
