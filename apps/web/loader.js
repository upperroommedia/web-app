"use client";

function normalizeFirebaseStorageUrl(src) {
  try {
    const url = new URL(src);

    if (url.hostname !== "firebasestorage.googleapis.com") {
      return src;
    }

    const match = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
    if (!match) {
      return src;
    }

    const [, bucketName, encodedObjectPath] = match;
    const objectPath = decodeURIComponent(encodedObjectPath);

    return `https://storage.googleapis.com/${bucketName}/${encodeURIComponent(objectPath).replace(/%2F/g, "/")}`;
  } catch {
    return src;
  }
}

export default function firebaseAppHostingImageLoader({ src, width, quality }) {
  if (process.env.NODE_ENV === "development") {
    return src;
  }

  // Files in public/ are already served as static assets. Sending them through
  // App Hosting's image processor adds a separate cold request for tiny assets
  // such as the site logo, and can even make the response larger.
  if (
    src.startsWith("/") &&
    !src.startsWith("//") &&
    /\.(?:avif|gif|ico|jpe?g|png|svg|webp)(?:[?#]|$)/i.test(src)
  ) {
    return src;
  }

  const normalizedSrc = normalizeFirebaseStorageUrl(src);
  const operations = [
    {
      operation: "input",
      type: "url",
      url: normalizedSrc,
    },
    { operation: "resize", width },
    { operation: "output", format: "webp", quality: quality || 75 },
  ];

  return `/_fah/image/process?operations=${encodeURIComponent(JSON.stringify(operations))}`;
}
