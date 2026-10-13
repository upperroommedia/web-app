import localFont from 'next/font/local';

// Vendored official Inter variable font: no Google Fonts request at build or runtime.
export const appInter = localFont({
  src: './fonts/InterVariable.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  preload: true,
  fallback: ['Arial'],
  adjustFontFallback: 'Arial',
});
