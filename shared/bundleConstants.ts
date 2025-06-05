// Shared constants for bundle system - used by both client and server
export const BUNDLE_METADATA_PATHS = {
    TOPICS: 'metadata/topic-bundle',
    SUBTITLES: 'metadata/subtitle-bundle',
    BIBLE_CHAPTERS: 'metadata/bible-chapter-bundle',
    SUNDAY_HOMILIES: 'metadata/sunday-homily-bundle'
} as const;

export const BUNDLE_STORAGE_PATHS = {
    TOPICS: 'bundles/topics-bundle.bin',
    SUBTITLES: 'bundles/subtitles-bundle.bin',
    BIBLE_CHAPTERS: 'bundles/bible-chapters-bundle.bin',
    SUNDAY_HOMILIES: 'bundles/sunday-homilies-bundle.bin'
} as const;

export const BUNDLE_NAMES = {
    TOPICS: 'topics-bundle',
    SUBTITLES: 'subtitles-bundle',
    BIBLE_CHAPTERS: 'bible-chapters-bundle',
    SUNDAY_HOMILIES: 'sunday-homilies-bundle'
} as const;

export const NAMED_QUERIES = {
    TOPICS: 'latest-topics-query',
    SUBTITLES: 'latest-subtitles-query',
    BIBLE_CHAPTERS: 'latest-bible-chapters-query',
    SUNDAY_HOMILIES: 'latest-sunday-homilies-query'
} as const;

// Collection paths for document listeners
export const COLLECTION_PATHS = {
    TOPICS: 'topics/{topicId}',
    SUBTITLES: 'lists/{listId}',
    BIBLE_CHAPTERS: 'lists/{listId}',
    SUNDAY_HOMILIES: 'lists/{listId}'
} as const; 