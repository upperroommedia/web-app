"use client";

export default function firebaseAppHostingImageLoader({ src, width, quality }) {
  if (process.env.NODE_ENV === "development") {
    return src;
  }

  const operations = [
    {
      operation: "input",
      type: "url",
      url: src,
    },
    { operation: "resize", width },
    { operation: "output", format: "webp", quality: quality || 75 },
  ];

  return `/_fah/image/process?operations=${encodeURIComponent(JSON.stringify(operations))}`;
}
