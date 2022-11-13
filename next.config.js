/** @type {import('next').NextConfig} */

const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
});

const nextConfig = withBundleAnalyzer({
  reactStrictMode: true,
  images: {
    domains: [
      'lh3.googleusercontent.com',
      'core.subsplash.com',
      'localhost',
      '127.0.0.1',
      'https://storage.googleapis.com/urm-app-images',
    ],
    formats: ['image/avif', 'image/webp', 'image/jpeg', 'image/png'],
  },
  i18n: {
    locales: ['en'],
    defaultLocale: 'en',
  },
});
module.exports = nextConfig;
