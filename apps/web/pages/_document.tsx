import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en" suppressHydrationWarning>
      <Head />
      <body>
        <style>{`.firebase-emulator-warning { display: none; }`}</style>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
