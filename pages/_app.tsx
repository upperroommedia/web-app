import '../styles/globals.css';
import type { AppProps } from 'next/app';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import UserState from '../context/user/UserState';
import { AudioPlayerProvider } from '../context/audio/audioPlayerContext';

function MyApp({ Component, pageProps: { session, ...pageProps } }: AppProps) {
  return (
    <UserState>
      <Navbar />
      <AudioPlayerProvider>
        <Component {...pageProps} />
      </AudioPlayerProvider>
      <Footer />
    </UserState>
  );
}

export default MyApp;
