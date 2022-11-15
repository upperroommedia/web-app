import '../styles/globals.css';
import type { AppProps } from 'next/app';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { AudioPlayerProvider } from '../context/audio/audioPlayerContext';
import { UserProvider } from '../context/user/UserContext';
import NextNProgress from 'nextjs-progressbar';

function MyApp({ Component, pageProps: { ...pageProps } }: AppProps) {
  return (
    <UserProvider>
      <Navbar />
      <AudioPlayerProvider>
        <NextNProgress />
        <Component {...pageProps} />
      </AudioPlayerProvider>
      <Footer />
    </UserProvider>
  );
}

export default MyApp;
