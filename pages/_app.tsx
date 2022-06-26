import '../styles/globals.css';
import type { AppProps } from 'next/app';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import UserState from '../context/user/UserState';

function MyApp({ Component, pageProps: { session, ...pageProps } }: AppProps) {
  return (
    <UserState>
      <Navbar />
      <Component {...pageProps} />
      <Footer />
    </UserState>
  );
}

export default MyApp;
