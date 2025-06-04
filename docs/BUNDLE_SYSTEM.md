# Firebase Bundle System

This implementation uses Firebase bundles to improve performance and reduce costs when loading data from Firestore. The system is generic and currently supports both topics and subtitles (category lists).

## Overview

Firebase bundles allow you to package Firestore queries and documents into a cached format that can be served directly to clients. This reduces database reads and provides faster loading times.

## Architecture

### Generic Bundle Manager

The `BundleManager<T>` class is a generic singleton that can handle any data type:

```typescript
const topicManager = BundleManager.getInstance<Topic>(TOPIC_BUNDLE_CONFIG);
const subtitleManager = BundleManager.getInstance<List>(SUBTITLE_BUNDLE_CONFIG);
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
```

### Server-side Components

1. **Generic Bundle Creation Utilities** (`functions/src/utils/bundleCreationUtils.ts`)
   - `createBundleHandler`: Generic HTTP handler for serving bundles
   - `generateAndStoreBundle`: Generic function for creating and storing bundles
   - `serveBundleFromStorage`: Utility for serving cached bundles

2. **Bundle Cloud Functions**
   - `createTopicBundle`: Uses generic utilities with topic configuration
   - `createSubtitleBundle`: Uses generic utilities with subtitle configuration
   - Both export their configurations for use by listeners

3. **Generic Document Listener Utilities** (`functions/src/utils/bundleListenerUtils.ts`)
   - `createBundleDocumentListener`: Generic listener factory with metadata tracking
   - Handles operation detection, logging, and bundle regeneration
   - Tracks regeneration metadata for debugging and monitoring

4. **Document Listeners** (both use identical structure)
   - `topicOnWrite`: Uses generic listener utility with topic configuration
   - `subtitleListOnWrite`: Uses generic listener utility with subtitle configuration

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

4. **UI Components**
   - `BundleListSelector`: Enhanced ListSelector that uses bundles for topics and subtitles
   - Falls back to Algolia/Firestore for other list types

## Benefits

### Performance
- **Faster loading**: Data loads from local cache instead of network requests
- **Offline support**: Works without internet connection once cached
- **Reduced latency**: No API calls needed for searching

### Cost Reduction
- **Fewer Firestore reads**: Bundle contains all data upfront
- **Reduced bandwidth**: Only downloads when data changes
- **No additional search service costs**: Local search replaces external services

### Code Quality
- **DRY Principle**: Generic utilities eliminate code duplication
- **Type Safety**: Full TypeScript support with generics
- **Maintainability**: Single source of truth for bundle logic
- **Consistent Structure**: All components follow the same patterns

### Better User Experience
- **Instant search**: No network delay for search results
- **Consistent performance**: Not dependent on network conditions
- **Progressive enhancement**: Falls back gracefully if bundles fail

## Usage

### Using Bundle Managers Directly

```typescript
import { BundleManager } from '../utils/bundleManager';
import { TOPIC_BUNDLE_CONFIG, SUBTITLE_BUNDLE_CONFIG } from '../utils/bundleConfigs';

// Get topics
const topicManager = BundleManager.getInstance<Topic>(TOPIC_BUNDLE_CONFIG);
const topics = await topicManager.getData();

// Get subtitles
const subtitleManager = BundleManager.getInstance<List>(SUBTITLE_BUNDLE_CONFIG);
const subtitles = await subtitleManager.getData();
```

### Using Helper Functions

```typescript
import { getTopicsFromBundle, getSubtitlesFromBundle } from '../utils/bundleHelpers';

// Simplified access
const topics = await getTopicsFromBundle();
const subtitles = await getSubtitlesFromBundle();
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

// For any searchable data type
interface Person { id: string; name: string; email: string; }
const personSearch = new LocalSearch<Person>(people, 'name', 'people');
```

### In Components

```tsx
// For topic lists
<BundleListSelector 
  sermonList={sermonList} 
  setSermonList={setSermonList} 
  listType={ListType.TOPIC_LIST} 
/>

// For subtitle lists
<BundleListSelector 
  sermonList={sermonList} 
  setSermonList={setSermonList} 
  listType={ListType.CATEGORY_LIST} 
/>
```

## Adding New Bundle Types

To add a new bundle type, use the consistent pattern:

1. **Create Bundle Configuration**
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

2. **Create Cloud Function**
```typescript
import { createBundleHandler } from './utils/bundleCreationUtils';

export const createNewBundle = onRequest({}, async (request, response) => {
    await createBundleHandler(NEW_BUNDLE_CONFIG, request, response);
});

export { NEW_BUNDLE_CONFIG };
```

3. **Create Document Listener**
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

4. **Use Generic Search**
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
- System automatically falls back to cached data

### Search Not Working
- Verify Fuse.js is installed
- Check that data is loaded into LocalSearch instances
- Ensure bundle contains expected data

### Cache Issues
- Clear browser localStorage
- Force refresh with `manager.getData(true)`
- Check bundle metadata in Firestore

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
``` 