import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const MAINTENANCE_HOST = 'uploader.upperroommedia.org';

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Uploader Maintenance</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe6;
        --surface: rgba(255, 255, 255, 0.88);
        --text: #1b1a18;
        --muted: #5b5852;
        --accent: #9b3d24;
        --border: rgba(27, 26, 24, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: Georgia, "Times New Roman", serif;
        background:
          radial-gradient(circle at top, rgba(155, 61, 36, 0.16), transparent 36%),
          linear-gradient(180deg, #f8f4ec 0%, var(--bg) 100%);
        color: var(--text);
      }

      main {
        width: min(640px, 100%);
        padding: 40px 32px;
        border: 1px solid var(--border);
        border-radius: 24px;
        background: var(--surface);
        backdrop-filter: blur(10px);
        box-shadow: 0 20px 60px rgba(27, 26, 24, 0.08);
      }

      .eyebrow {
        margin: 0 0 12px;
        font-size: 12px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--accent);
      }

      h1 {
        margin: 0 0 16px;
        font-size: clamp(2.2rem, 4vw, 3.6rem);
        line-height: 0.95;
      }

      p {
        margin: 0;
        font-size: 1.05rem;
        line-height: 1.7;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Upper Room Media</p>
      <h1>Uploader is down for maintenance</h1>
      <p>
        We are making updates right now. Please check back shortly.
      </p>
    </main>
  </body>
</html>`;

export function proxy(request: NextRequest) {
  if (request.nextUrl.hostname.toLowerCase() !== MAINTENANCE_HOST) {
    return NextResponse.next();
  }

  return new NextResponse(html, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=UTF-8',
      'cache-control': 'no-store, no-cache, must-revalidate, private',
      'retry-after': '3600',
    },
  });
}
