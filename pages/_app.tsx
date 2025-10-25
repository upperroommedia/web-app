import '../styles/globals.css';
import type { AppProps } from 'next/app';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
// import { AudioPlayerProvider } from '../context/audio/audioPlayerContext';
import { UserProvider } from '../context/user/UserContext';
import { createTheme, responsiveFontSizes, ThemeProvider } from '@mui/material/styles';
import Head from 'next/head';
import '@vidstack/react/player/styles/default/theme.css';
import Box from '@mui/material/Box';
import React, { useMemo } from 'react';
import { AudioPlayerProvider } from '../context/audio/audioPlayerContext';
import dynamic from 'next/dynamic';

// ✅ Dynamic import for MediaPlayerComponent to reduce initial bundle size
const MediaPlayerComponent = dynamic(() => import('../components/MediaPlayerComponent'), {
  ssr: false, // Media player doesn't need SSR
});

type ComponentWithPageLayout = AppProps & {
  Component: AppProps['Component'] & {
    PageLayout?: React.ComponentType<{ children: React.ReactNode }>;
  };
};

function MyApp({ Component, pageProps }: ComponentWithPageLayout) {
  // ✅ Memoize theme creation to avoid recreation on every render
  const theme = useMemo(() => {
    const baseTheme = createTheme();
    return responsiveFontSizes(baseTheme, { factor: 4 });
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
        {/* ✅ Preload critical resources */}
        <link rel="preload" href="/URM_icon.png" as="image" />
      </Head>
      <UserProvider>
        <ThemeProvider theme={theme}>
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
                }}
              >
                <Navbar />
                {Component.PageLayout ? (
                  <Component.PageLayout>
                    <Component {...pageProps} />
                  </Component.PageLayout>
                ) : (
                  <Component {...pageProps} />
                )}
                <Footer />
              </Box>
            </MediaPlayerComponent>
          </AudioPlayerProvider>
        </ThemeProvider>
      </UserProvider>
    </>
  );
}

export default MyApp;
