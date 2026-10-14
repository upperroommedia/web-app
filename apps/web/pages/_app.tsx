import '../styles/globals.css';
import type { AppProps } from 'next/app';
import { UserProvider } from '../context/user/UserContext';
import { ThemeProvider as MuiThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import Head from 'next/head';
import Box from '@mui/material/Box';
import React, { useEffect, useMemo } from 'react';
import { AudioPlayerProvider } from '../context/audio/audioPlayerContext';
import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes';
import { darkTheme, lightTheme } from '../styles/theme';
import { appInter } from '../styles/fonts';
import { AlgoliaSearchProvider } from '../context/search/AlgoliaSearchContext';
import { installConsoleErrorCapture } from '../utils/reportHandledError';
import { useHydratedTheme } from '../hooks/useHydratedTheme';
import { browserAlgoliaAppId } from '../utils/algolia/browserSearch';

// The SSR-safe player context must preserve page children in initial HTML.
// Its visible controls/provider remain lazy inside MediaPlayerComponent.
import MediaPlayerComponent from '../components/MediaPlayerComponent';

type ComponentWithPageLayout = AppProps & {
  Component: AppProps['Component'] & {
    PageLayout?: React.ComponentType<{ children: React.ReactNode }>;
  };
};

// Inner component that uses the theme
function AppContent({ Component, pageProps }: Omit<ComponentWithPageLayout, 'router'>) {
  const { resolvedTheme } = useTheme();

  const displayTheme = useHydratedTheme(resolvedTheme);

  // Apply the preferred theme after hydration without withholding page content.
  const muiTheme = useMemo(() => {
    return displayTheme === 'light' ? lightTheme : darkTheme;
  }, [displayTheme]);

  return (
    <MuiThemeProvider theme={muiTheme}>
      <CssBaseline />
      <AudioPlayerProvider>
        <MediaPlayerComponent>
          <Box
            sx={{
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              flexGrow: 1,
              minHeight: '100vh',
              bgcolor: 'background.default',
            }}
          >
            {Component.PageLayout ? (
              <Component.PageLayout>
                <Component {...pageProps} />
              </Component.PageLayout>
            ) : (
              <Component {...pageProps} />
            )}
          </Box>
        </MediaPlayerComponent>
      </AudioPlayerProvider>
    </MuiThemeProvider>
  );
}

function MyApp({ Component, pageProps }: ComponentWithPageLayout) {
  const algoliaAppId = browserAlgoliaAppId;

  useEffect(() => {
    installConsoleErrorCapture();
  }, []);

  return (
    <>
      <Head>
        <title>Upper Room Media</title>
        <meta property="og:title" content="Upper Room Media" key="title" />
        <meta
          name="description"
          content="Bringing the Word of God from a timeless faith into your hearts and minds anytime, anywhere.
Upper Room Media is a ministry of the Coptic Orthodox Church that brings to you rich & fresh spiritual resources including Sermons, Music, Videos, Blogs and much more!"
          key="description"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/URM_icon.png" />
        <link rel="apple-touch-icon" href="/URM_icon.png"></link>
        {algoliaAppId && (
          <>
            <link rel="preconnect" href={`https://${algoliaAppId}-dsn.algolia.net`} crossOrigin="anonymous" />
            <link rel="dns-prefetch" href={`https://${algoliaAppId}-dsn.algolia.net`} />
          </>
        )}
      </Head>
      <style jsx global>{`
        :root {
          --font-inter: ${appInter.style.fontFamily};
        }
      `}</style>
      <UserProvider>
        <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <AlgoliaSearchProvider>
            <AppContent Component={Component} pageProps={pageProps} />
          </AlgoliaSearchProvider>
        </NextThemesProvider>
      </UserProvider>
    </>
  );
}

export default MyApp;
