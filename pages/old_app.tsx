import '../styles/globals.css';
import type { AppProps } from 'next/app';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { AudioPlayerProvider } from '../context/audio/audioPlayerContext';
import { UserProvider } from '../context/user/UserContext';
import NextNProgress from 'nextjs-progressbar';
import { createTheme, responsiveFontSizes } from '@mui/material/styles';
import ThemeProvider from '@mui/system/ThemeProvider';
import Head from 'next/head';

let theme = createTheme();
theme = responsiveFontSizes(theme, { factor: 4 });

type ComponentWithPageLayout = AppProps & {
  Component: AppProps['Component'] & {
    PageLayout?: React.ComponentType<{ children: React.ReactNode }>;
  };
};

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
        <link rel="icon" href="/URM_icon.png" />
      </Head>
      <UserProvider>
        <ThemeProvider theme={theme}>
          <Navbar />
          <AudioPlayerProvider>
            <NextNProgress options={{ showSpinner: false }} />
            {Component.PageLayout ? (
              <Component.PageLayout>
                <Component {...pageProps} />
              </Component.PageLayout>
            ) : (
              <Component {...pageProps} />
            )}
          </AudioPlayerProvider>
          <Footer />
        </ThemeProvider>
      </UserProvider>
    </>
  );
}

export default MyApp;
