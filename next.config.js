/** @type {import('next').NextConfig} */

const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'graph.facebook.com' },
      { protocol: 'https', hostname: 'account.microsoft.com' },
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
      { protocol: 'https', hostname: 'core.subsplash.com' },
      { protocol: 'https', hostname: 'localhost' },
      { protocol: 'http', hostname: '127.0.0.1' },
      { protocol: 'https', hostname: 'storage.googleapis.com' },
      { protocol: 'https', hostname: 'storage.cloud.google.com' },
    ],
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [24, 30, 36, 40, 50, 100, 150],
    minimumCacheTTL: 31536000,
  },
  i18n: {
    locales: ['en'],
    defaultLocale: 'en',
  },
  async redirects() {
    return [{ source: '/admin', destination: '/admin/sermons', permanent: true }];
  },
  compress: true,
  poweredByHeader: false,
  turbopack: {
    root: __dirname,
  },
};

module.exports = nextConfig;
