import Navbar from '../components/Navbar';
import ThemeProvider from '../components/ThemeProvider';
import { AudioPlayerProvider } from '../context/audio/audioPlayerContext';

export default function RootLayout({
  // Layouts must accept a children prop.
  // This will be populated with nested layouts or pages
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: 0,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Fira Sans, Droid Sans,Helvetica Neue, sans-serif',
        }}
      >
        <ThemeProvider>
          <Navbar />
          <AudioPlayerProvider>{children}</AudioPlayerProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
