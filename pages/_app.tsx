import '../styles/globals.css';
import type { AppProps } from 'next/app';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { UserProvider } from '../context/user/UserContext';
import { ThemeProvider as MuiThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import Head from 'next/head';
import '@vidstack/react/player/styles/default/theme.css';
import Box from '@mui/material/Box';
import React, { useMemo } from 'react';
import { AudioPlayerProvider } from '../context/audio/audioPlayerContext';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes';
import { darkTheme, lightTheme } from '../styles/theme';

// Dynamic import for MediaPlayerComponent to reduce initial bundle size
const MediaPlayerComponent = dynamic(() => import('../components/MediaPlayerComponent'), {
  ssr: false,
});

type ComponentWithPageLayout = AppProps & {
  Component: AppProps['Component'] & {
    PageLayout?: React.ComponentType<{ children: React.ReactNode }>;
  };
};

// Inner component that uses the theme
function AppContent({ Component, pageProps }: Omit<ComponentWithPageLayout, 'router'>) {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const isAdminPage = router.pathname.startsWith('/admin') || router.pathname === '/';

  // Select theme based on next-themes
  const muiTheme = useMemo(() => {
    return resolvedTheme === 'light' ? lightTheme : darkTheme;
  }, [resolvedTheme]);

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
              overflowY: 'auto',
              flexGrow: 1,
              minHeight: '100vh',
              bgcolor: isAdminPage ? 'background.default' : 'inherit',
            }}
          >
            {/* Hide main Navbar on admin pages since sidebar has navigation */}
            {!isAdminPage && <Navbar />}
            {Component.PageLayout ? (
              <Component.PageLayout>
                <Component {...pageProps} />
              </Component.PageLayout>
            ) : (
              <Component {...pageProps} />
            )}
            {/* Hide Footer on admin pages for cleaner look */}
            {!isAdminPage && <Footer />}
          </Box>
        </MediaPlayerComponent>
      </AudioPlayerProvider>
    </MuiThemeProvider>
  );
}

function MyApp({ Component, pageProps }: ComponentWithPageLayout) {
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
      </Head>
      <UserProvider>
        <NextThemesProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <AppContent Component={Component} pageProps={pageProps} />
        </NextThemesProvider>
      </UserProvider>
    </>
  );
}

export default MyApp;
