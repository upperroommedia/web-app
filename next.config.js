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
      'storage.googleapis.com',
      'storage.cloud.google.com',
    ],
    formats: ['image/avif', 'image/webp'],
  },
  async redirects() {
    return [{ source: '/admin', destination: '/admin/sermons', permanent: true }];
  },
});
module.exports = nextConfig;
