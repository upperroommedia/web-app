import '../styles/globals.css';
import type { AppProps } from 'next/app';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { AudioPlayerProvider } from '../context/audio/audioPlayerContext';
import { UserProvider } from '../context/user/UserContext';
import NextNProgress from 'nextjs-progressbar';

type ComponentWithPageLayout = AppProps & {
  Component: AppProps['Component'] & {
    PageLayout?: React.ComponentType<{ children: React.ReactNode }>;
  };
};

function MyApp({ Component, pageProps }: ComponentWithPageLayout) {
  return (
    <UserProvider>
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
    </UserProvider>
  );
}

export default MyApp;
