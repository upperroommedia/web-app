import '../styles/globals.css';
import type { AppProps } from 'next/app';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { AudioPlayerProvider } from '../context/audio/audioPlayerContext';
import { UserProvider } from '../context/user/UserContext';

function MyApp({ Component, pageProps: { session, ...pageProps } }: AppProps) {
  return (
    <UserProvider>
      <Navbar />
      <AudioPlayerProvider>
        <Component {...pageProps} />
      </AudioPlayerProvider>
      <Footer />
    </UserProvider>
  );
}

export default MyApp;
