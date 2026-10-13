import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { ThemeProvider } from '@mui/material/styles';
import { darkTheme } from '../styles/theme';
import LoginPage from '../pages/login';

jest.mock('../components/Login', () => ({ __esModule: true, default: () => createElement('button', null, 'Sign in') }));
jest.mock('next/head', () => ({ __esModule: true, default: () => null }));

it('login server render receives the Material palette instead of emitting unresolved theme tokens', () => {
  const html = renderToString(createElement(ThemeProvider, { theme: darkTheme }, createElement(LoginPage)));
  expect(html).toContain('background-color:#0f1115');
  expect(html).not.toContain('background-color:background.default');
  expect(html).toContain('Welcome Back');
  expect(html).toContain('Sign in');
  expect(html).not.toContain('srcSet=');
});
