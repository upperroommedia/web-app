import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let isAdmin = false;
let authenticated = true;
jest.mock('../context/user/UserContext', () => ({
  __esModule: true,
  default: () => ({ user: authenticated ? { isAdmin: () => isAdmin } : undefined }),
}));
jest.mock('../layout/AppLayout', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
import AdminActivityLayout from '../layout/AdminActivityLayout';

const mountOperationalPage = jest.fn();
function OperationalPage() {
  mountOperationalPage();
  return <div>Operational task details</div>;
}
function renderPage() {
  return renderToStaticMarkup(
    <AdminActivityLayout>
      <OperationalPage />
    </AdminActivityLayout>
  );
}
beforeEach(() => {
  authenticated = true;
  isAdmin = false;
  mountOperationalPage.mockClear();
});
it('does not mount operational queries or controls for a non-administrator', () => {
  expect(renderPage()).toContain('Only administrators can view Activity.');
  expect(mountOperationalPage).not.toHaveBeenCalled();
});
it('does not mount operational content while identity is unavailable', () => {
  authenticated = false;
  expect(renderPage()).not.toContain('Operational task details');
  expect(mountOperationalPage).not.toHaveBeenCalled();
});
it('mounts the operational page for an administrator', () => {
  isAdmin = true;
  expect(renderPage()).toContain('Operational task details');
  expect(mountOperationalPage).toHaveBeenCalledTimes(1);
});
it('removes operational content after administrator access is lost', () => {
  isAdmin = true;
  renderPage();
  mountOperationalPage.mockClear();
  isAdmin = false;
  expect(renderPage()).not.toContain('Operational task details');
  expect(mountOperationalPage).not.toHaveBeenCalled();
});
