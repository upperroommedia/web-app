import type { NextApiRequest, NextApiResponse } from 'next';

const ALLOWED_STORAGE_HOSTS = new Set(['firebasestorage.googleapis.com']);

function isAllowedStorageUrl(sourceUrl: string): boolean {
  try {
    const url = new URL(sourceUrl);
    if (!ALLOWED_STORAGE_HOSTS.has(url.hostname)) return false;

    const path = decodeURIComponent(url.pathname);
    return path.includes('/o/sermons/') || path.includes('/o/processed-sermons/');
  } catch {
    return false;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).end('Method Not Allowed');
    return;
  }

  const sourceUrl = typeof req.query.sourceUrl === 'string' ? req.query.sourceUrl : '';
  if (!sourceUrl || !isAllowedStorageUrl(sourceUrl)) {
    res.status(400).json({ error: 'Invalid sourceUrl' });
    return;
  }

  try {
    const upstream = await fetch(sourceUrl);
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'Failed to fetch source audio' });
      return;
    }

    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
    const cacheControl = upstream.headers.get('cache-control') || 'public, max-age=300';
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', cacheControl);
    res.status(200).send(buffer);
  } catch (error) {
    console.error('Error proxying audio for waveform generation:', error);
    res.status(502).json({ error: 'Failed to proxy source audio' });
  }
}
