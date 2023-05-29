'use client';
import { createTheme, responsiveFontSizes } from '@mui/material/styles';
import MUIThemeProvider from '@mui/system/ThemeProvider';

let theme = createTheme();
theme = responsiveFontSizes(theme, { factor: 4 });

export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <MUIThemeProvider theme={theme}>{children}</MUIThemeProvider>;
}
