/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path');
const fs = require('node:fs');

/** @type {import('next').NextConfig} */

const rootEnvFiles = ['.env', '.env.local'];
const repoRoot = path.join(__dirname, '../..');

const stripWrappingQuotes = (value) => {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }

  return value;
};

const parseEnvFile = (content) => {
  const parsed = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    parsed[key] = stripWrappingQuotes(line.slice(separatorIndex + 1).trim());
  }

  return parsed;
};

const loadRootEnv = () => {
  const loadedEnv = {};

  for (const fileName of rootEnvFiles) {
    const absolutePath = path.join(repoRoot, fileName);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    Object.assign(loadedEnv, parseEnvFile(fs.readFileSync(absolutePath, 'utf8')));
  }

  for (const [key, value] of Object.entries(loadedEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
};

loadRootEnv();

const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: repoRoot,
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'graph.facebook.com' },
      { protocol: 'https', hostname: 'account.microsoft.com' },
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
      { protocol: 'https', hostname: 'core.subsplash.com' },
      { protocol: 'https', hostname: 'cdn.subsplash.com' },
      { protocol: 'https', hostname: 'images.subsplash.com' },
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
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Robots-Tag',
            value: 'noindex, nofollow, noarchive, nosnippet, noimageindex',
          },
        ],
      },
    ];
  },
  async redirects() {
    return [{ source: '/admin', destination: '/admin/sermons', permanent: true }];
  },
  compress: true,
  poweredByHeader: false,
  turbopack: {
    root: repoRoot,
  },
};

module.exports = nextConfig;
