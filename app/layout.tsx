import { ServerAuthProvider } from '../auth/server-auth-provider';
import Navbar from '../components/Navbar';
import ThemeProvider from '../components/ThemeProvider';
import { AudioPlayerProvider } from '../context/audio/audioPlayerContext';
import '../styles/global.css';

export default function RootLayout({
  // Layouts must accept a children prop.
  // This will be populated with nested layouts or pages
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {/* @ts-expect-error https://github.com/vercel/next.js/issues/43537 */}
        <ServerAuthProvider>
          <ThemeProvider>
            <Navbar />
            <AudioPlayerProvider>{children}</AudioPlayerProvider>
          </ThemeProvider>
        </ServerAuthProvider>
      </body>
    </html>
  );
}
