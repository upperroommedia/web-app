// Algolia's official InstantSearch wordmark, kept local for reliable display.
export default function SearchAttribution() {
  return (
    <a
      href="https://www.algolia.com/"
      aria-label="Search by Algolia"
      target="_blank"
      rel="noopener noreferrer"
      style={{ display: 'inline-flex', padding: '6px', background: '#fff', borderRadius: 4, alignSelf: 'flex-start' }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/search-by-algolia.svg" alt="Search by Algolia" width={143} height={16} />
    </a>
  );
}
