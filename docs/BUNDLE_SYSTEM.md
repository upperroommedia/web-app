# Firebase Bundle System

This implementation uses Firebase bundles to improve performance and reduce costs when loading data from Firestore. The system is generic and currently supports topics, subtitles (category lists), bible chapters, and sunday homilies.

## Overview

Firebase bundles allow you to package Firestore queries and documents into a cached format that can be served directly to clients. This reduces database reads and provides faster loading times.

## Architecture

### Generic Bundle Manager

The `BundleManager<T>` class is a generic singleton that can handle any data type:

```typescript
const topicManager = BundleManager.getInstance<Topic>(TOPIC_BUNDLE_CONFIG);
const subtitleManager = BundleManager.getInstance<List>(SUBTITLE_BUNDLE_CONFIG);
const bibleChapterManager = BundleManager.getInstance<List>(BIBLE_CHAPTER_BUNDLE_CONFIG);
const sundayHomilyManager = BundleManager.getInstance<List>(SUNDAY_HOMILY_BUNDLE_CONFIG);
```

### Bundle Configurations

Each bundle type has its own configuration:

```typescript
export const TOPIC_BUNDLE_CONFIG: BundleCreationConfig<Topic> = {
    collectionName: 'topics',
    converter: firestoreAdminTopicConverter,
    bundleName: 'topics-bundle',
    namedQueryName: 'latest-topics-query',
    bundlePath: 'bundles/topics-bundle.bin',
    metadataDocPath: 'metadata/topic-bundle',
    countFieldName: 'topics',
    displayName: 'topics',
    orderByField: 'title'
};

export const SUBTITLE_BUNDLE_CONFIG: BundleCreationConfig<List> = {
    collectionName: 'lists',
    converter: firestoreAdminListConverter,
    bundleName: 'subtitles-bundle',
    namedQueryName: 'latest-subtitles-query',
    bundlePath: 'bundles/subtitles-bundle.bin',
    metadataDocPath: 'metadata/subtitle-bundle',
    countFieldName: 'subtitles',
    displayName: 'subtitles',
    orderByField: 'name',
    whereConditions: [
        { field: 'type', operator: '==', value: ListType.CATEGORY_LIST }
    ]
};

export const BIBLE_CHAPTER_BUNDLE_CONFIG: BundleCreationConfig<List> = {
    collectionName: 'lists',
    converter: firestoreAdminListConverter,
    bundleName: 'bible-chapters-bundle',
    namedQueryName: 'latest-bible-chapters-query',
    bundlePath: 'bundles/bible-chapters-bundle.bin',
    metadataDocPath: 'metadata/bible-chapter-bundle',
    countFieldName: 'bibleChapters',
    displayName: 'bible chapters',
    orderByField: 'listTagAndPosition.position',
    whereConditions: [
        { field: 'listTagAndPosition.listTag', operator: '==', value: ListTag.BIBLE_CHAPTER }
    ]
};

export const SUNDAY_HOMILY_BUNDLE_CONFIG: BundleCreationConfig<List> = {
    collectionName: 'lists',
    converter: firestoreAdminListConverter,
    bundleName: 'sunday-homilies-bundle',
    namedQueryName: 'latest-sunday-homilies-query',
    bundlePath: 'bundles/sunday-homilies-bundle.bin',
    metadataDocPath: 'metadata/sunday-homily-bundle',
    countFieldName: 'sundayHomilies',
    displayName: 'sunday homilies',
    orderByField: 'listTagAndPosition.position',
    whereConditions: [
        { field: 'listTagAndPosition.listTag', operator: '==', value: ListTag.SUNDAY_HOMILY_MONTH }
    ]
};
```

### Server-side Components

1. **Generic Bundle Creation Utilities** (`functions/src/utils/bundleCreationUtils.ts`)
   - `createBundleHandler`: Generic HTTP handler for serving bundles
   - `generateAndStoreBundle`: Generic function for creating and storing bundles
   - `serveBundleFromStorage`: Utility for serving cached bundles

2. **Bundle Cloud Functions**
   - `createTopicBundle`: Uses generic utilities with topic configuration
   - `createSubtitleBundle`: Uses generic utilities with subtitle configuration
   - `createBibleChapterBundle`: Uses generic utilities with bible chapter configuration
   - `createSundayHomilyBundle`: Uses generic utilities with sunday homily configuration
   - All export their configurations for use by listeners

3. **Generic Document Listener Utilities** (`functions/src/utils/bundleListenerUtils.ts`)
   - `createBundleDocumentListener`: Generic listener factory with metadata tracking
   - Handles operation detection, logging, and bundle regeneration
   - Tracks regeneration metadata for debugging and monitoring

4. **Document Listeners** (all use identical structure)
   - `topicOnWrite`: Uses generic listener utility with topic configuration
   - `subtitleListOnWrite`: Uses generic listener utility with subtitle configuration
   - `bibleChapterListOnWrite`: Uses generic listener utility with bible chapter configuration
   - `sundayHomilyListOnWrite`: Uses generic listener utility with sunday homily configuration

### Client-side Components

1. **Generic BundleManager** (`utils/bundleManager.ts`)
   - Singleton pattern with type safety
   - Handles bundle loading, caching, and fallbacks
   - Automatic cache invalidation

2. **Generic Local Search** (`utils/localSearch.ts`)
   - `LocalSearch<T>`: Generic search class using Fuse.js
   - Type-safe and configurable for any searchable data type

3. **Helper Functions** (`utils/bundleHelpers.ts`)
   - Convenient access to bundle managers
   - Simplified data fetching functions
   - Support for all bundle types

4. **UI Components**
   - `BundleListSelector`: Enhanced ListSelector that uses bundles for topics and subtitles
   - `BibleChapterSelector`: Uses bible chapter bundles with fallback to Firestore
   - `SundayHomilyMonthSelector`: Uses sunday homily bundles with local year filtering
   - Falls back to Algolia/Firestore for other list types

## Benefits

### Performance
- **Faster loading**: Data loads from local cache instead of network requests
- **Offline support**: Works without internet connection once cached
- **Reduced latency**: No API calls needed for searching
- **Local filtering**: Complex queries (like year filtering) happen client-side

### Cost Reduction
- **Fewer Firestore reads**: Bundle contains all data upfront
- **Reduced bandwidth**: Only downloads when data changes
- **No additional search service costs**: Local search replaces external services
- **Efficient queries**: Pre-sorted and filtered data bundles

### Code Quality
- **DRY Principle**: Generic utilities eliminate code duplication
- **Type Safety**: Full TypeScript support with generics
- **Maintainability**: Single source of truth for bundle logic
- **Consistent Structure**: All components follow the same patterns

### Better User Experience
- **Instant search**: No network delay for search results
- **Consistent performance**: Not dependent on network conditions
- **Progressive enhancement**: Falls back gracefully if bundles fail
- **Responsive filtering**: Year/position filtering happens instantly

## Usage

### Using Bundle Managers Directly

```typescript
import { BundleManager } from '../utils/bundleManager';
import { 
    TOPIC_BUNDLE_CONFIG, 
    SUBTITLE_BUNDLE_CONFIG,
    BIBLE_CHAPTER_BUNDLE_CONFIG,
    SUNDAY_HOMILY_BUNDLE_CONFIG 
} from '../utils/bundleConfigs';

// Get different data types
const topicManager = BundleManager.getInstance<Topic>(TOPIC_BUNDLE_CONFIG);
const topics = await topicManager.getData();

const subtitleManager = BundleManager.getInstance<List>(SUBTITLE_BUNDLE_CONFIG);
const subtitles = await subtitleManager.getData();

const bibleChapterManager = BundleManager.getInstance<List>(BIBLE_CHAPTER_BUNDLE_CONFIG);
const bibleChapters = await bibleChapterManager.getData();

const sundayHomilyManager = BundleManager.getInstance<List>(SUNDAY_HOMILY_BUNDLE_CONFIG);
const sundayHomilies = await sundayHomilyManager.getData();
```

### Using Helper Functions

```typescript
import { 
    getTopicsFromBundle, 
    getSubtitlesFromBundle,
    getBibleChaptersFromBundle,
    getSundayHomiliesFromBundle 
} from '../utils/bundleHelpers';

// Simplified access
const topics = await getTopicsFromBundle();
const subtitles = await getSubtitlesFromBundle();
const bibleChapters = await getBibleChaptersFromBundle();
const sundayHomilies = await getSundayHomiliesFromBundle();

// With year filtering for sunday homilies
const currentYear = new Date().getFullYear();
const thisYearHomilies = sundayHomilies.filter(
    homily => homily.listTagAndPosition.year === currentYear
);
```

### Using Generic Search

```typescript
import { LocalSearch } from '../utils/localSearch';

// For topics
const topicSearch = new LocalSearch(topics, 'title', 'topics');
const topicResults = topicSearch.search('faith');

// For subtitles
const subtitleSearch = new LocalSearch(subtitles, 'name', 'subtitles');
const subtitleResults = subtitleSearch.search('worship');

// For bible chapters (search by name, already ordered by position)
const bibleChapterSearch = new LocalSearch(bibleChapters, 'name', 'bible chapters');
const chapterResults = bibleChapterSearch.search('genesis');

// For sunday homilies with custom filtering
const sundayHomilySearch = new LocalSearch(sundayHomilies, 'name', 'sunday homilies');
const homilyResults = sundayHomilySearch.filterItems(
    homily => homily.listTagAndPosition.year === 2024
);
```

### In Components

```tsx
// Topic lists
<BundleListSelector 
  sermonList={sermonList} 
  setSermonList={setSermonList} 
  listType={ListType.TOPIC_LIST} 
/>

// Subtitle lists
<BundleListSelector 
  sermonList={sermonList} 
  setSermonList={setSermonList} 
  listType={ListType.CATEGORY_LIST} 
/>

// Bible chapters (when subtitle is "Bible Studies")
<BibleChapterSelector 
  sermonSubtitle={sermon.subtitle}
  setSermonList={setSermonList}
  selectedChapter={selectedChapter}
  setSelectedChapter={setSelectedChapter}
  bibleChapterError={bibleChapterError}
  setBibleChapterError={setBibleChapterError}
/>

// Sunday homilies (when subtitle is "Sunday Homilies")
<SundayHomilyMonthSelector 
  sermonSubtitle={sermon.subtitle}
  date={date}
  setSermonList={setSermonList}
  selectedSundayHomiliesMonth={selectedSundayHomiliesMonth}
  setSelectedSundayHomiliesMonth={setSelectedSundayHomiliesMonth}
  sundayHomiliesYear={sundayHomiliesYear}
  setSundayHomiliesYear={setSundayHomiliesYear}
  sundayHomiliesMonthError={sundayHomiliesMonthError}
  setSundayHomiliesMonthError={setSundayHomiliesMonthError}
/>
```

## Adding New Bundle Types

To add a new bundle type, use the consistent pattern:

1. **Create Bundle Configuration (Client)**
```typescript
export const NEW_BUNDLE_CONFIG: BundleConfig = {
    bundleType: 'newtype',
    functionName: 'createnewbundle',
    namedQuery: 'latest-newtype-query',
    cacheKeyPrefix: 'newtype',
    displayName: 'new items'
};
```

2. **Create Bundle Configuration (Server)**
```typescript
export const NEW_BUNDLE_CONFIG: BundleCreationConfig<NewType> = {
    collectionName: 'newcollection',
    converter: firestoreAdminNewTypeConverter,
    bundleName: 'newtype-bundle',
    namedQueryName: 'latest-newtype-query',
    bundlePath: 'bundles/newtype-bundle.bin',
    metadataDocPath: 'metadata/newtype-bundle',
    countFieldName: 'newtype',
    displayName: 'new items',
    orderByField: 'name'
};
```

3. **Create Cloud Function**
```typescript
import { createBundleHandler } from './utils/bundleCreationUtils';

export const createNewBundle = onRequest({}, async (request, response) => {
    await createBundleHandler(NEW_BUNDLE_CONFIG, request, response);
});

export { NEW_BUNDLE_CONFIG };
```

4. **Create Document Listener**
```typescript
import { generateAndStoreBundle } from '../../utils/bundleCreationUtils';
import { NEW_BUNDLE_CONFIG } from '../../createNewBundle';
import { createBundleDocumentListener, BundleListenerConfig } from '../../utils/bundleListenerUtils';

const NEW_LISTENER_CONFIG: BundleListenerConfig = {
    collectionPath: 'newcollection/{docId}',
    bundleRegenerationFunction: () => generateAndStoreBundle(NEW_BUNDLE_CONFIG),
    displayName: 'new item',
    metadataDocPath: 'metadata/newtype-bundle',
    shouldTrigger: () => true // Or custom logic
};

const newTypeOnWrite = createBundleDocumentListener(NEW_LISTENER_CONFIG);
export default newTypeOnWrite;
```

5. **Add Helper Functions**
```typescript
export const getNewItemsFromBundle = async (forceRefresh: boolean = false): Promise<NewType[]> => {
    const manager = BundleManager.getInstance<NewType>(NEW_BUNDLE_CONFIG);
    return manager.getData(forceRefresh);
};
```

6. **Use in Components**
```typescript
const searchInstance = new LocalSearch(newItems, 'searchField', 'new items');
const results = searchInstance.search(query);
```

## Monitoring & Debugging

### Automatic Metadata Tracking
Each bundle regeneration is tracked with:
- `lastRegeneratedReason`: What triggered the regeneration
- `lastRegeneratedAt`: Timestamp of last regeneration
- `lastOperation`: Type of operation (created/updated/deleted)

### Bundle-specific Metadata Documents
- `metadata/topic-bundle`
- `metadata/subtitle-bundle`
- `metadata/bible-chapter-bundle`
- `metadata/sunday-homily-bundle`

### Monitoring
Monitor bundle performance through:
- Firebase Console (Cloud Functions logs)
- Browser DevTools (Network tab)
- Bundle metadata documents in Firestore
- Console logs from bundle managers

## Environment Setup

Add the following environment variable:
```
NEXT_PUBLIC_FIREBASE_FUNCTIONS_URL=https://your-region-your-project.cloudfunctions.net
```

## Troubleshooting

### Bundle Loading Fails
- Check network connectivity
- Verify Cloud Function deployment
- Check console logs for detailed error messages
- System automatically falls back to cached data or Firestore queries

### Search Not Working
- Verify Fuse.js is installed
- Check that data is loaded into LocalSearch instances
- Ensure bundle contains expected data

### Cache Issues
- Clear browser localStorage
- Force refresh with `manager.getData(true)`
- Check bundle metadata in Firestore

### Year Filtering Issues (Sunday Homilies)
- Verify `listTagAndPosition.year` field exists on documents
- Check client-side filtering logic
- Ensure proper typing with `SundayHomiliesMonthList`

## Migration from Previous Implementation

The system now uses a completely consistent pattern across all bundle types:

```typescript
// Consistent structure for all bundle types
const bundleManager = BundleManager.getInstance<DataType>(BUNDLE_CONFIG);
const data = await bundleManager.getData();

// Generic search for any data type
const search = new LocalSearch(data, 'searchField', 'display name');
const results = search.search(query);

// Helper functions for convenience
const data = await getDataFromBundle();

// Local filtering for complex queries
const filteredData = data.filter(item => item.someField === someValue);
``` 