import type { NextApiRequest, NextApiResponse } from 'next';
import { mkdir, appendFile } from 'fs/promises';
import path from 'path';

const logDir = path.join(process.cwd(), 'output', 'debug');
const logFile = path.join(logDir, 'trimmer-debug.log');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const enabled = process.env.TRIMMER_DEBUG_API === '1' || process.env.NODE_ENV !== 'production';
  if (!enabled) {
    return res.status(404).json({ error: 'Not Found' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    await mkdir(logDir, { recursive: true });
    const line = `${JSON.stringify(req.body)}\n`;
    await appendFile(logFile, line, 'utf8');
    return res.status(204).end();
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to write trimmer debug log',
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
