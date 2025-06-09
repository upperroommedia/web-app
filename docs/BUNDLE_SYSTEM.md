# Firebase Bundle System

This implementation uses [Firebase bundles](https://firebase.google.com/docs/firestore/bundles) to improve performance and reduce costs when loading frequently accessed data from Firestore. The system provides a generic, type-safe architecture that currently supports topics, subtitles (category lists), bible chapters, and sunday homilies.

## Overview

Firebase bundles allow you to package Firestore queries and documents into a binary format that can be cached and served directly to clients. This reduces database reads, provides faster loading times, and enables offline functionality.

### Key Benefits

- **Performance**: Data loads from local cache instead of network requests
- **Cost Reduction**: Fewer Firestore reads through bundle caching
- **Offline Support**: Works without internet connection once cached
- **Type Safety**: Full TypeScript support with generic architecture
- **Consistency**: Unified logging and error handling across all bundle types

## Architecture

### Core Components

The bundle system consists of four main layers:

1. **Shared Configurations** (`shared/bundleConfigs.ts`)
2. **Server-side Bundle Creation** (Cloud Functions)
3. **Client-side Bundle Management** (`utils/bundleManager.ts`)
4. **UI Components** with bundle integration

## Bundle Configurations

All bundle types share a common configuration structure defined in `shared/bundleConfigs.ts`:

```typescript
export interface BundleConfig<T> {
    bundleType: string;           // Unique identifier for the bundle type
    functionName: string;         // Cloud Function name for serving bundles
    namedQuery: string;          // Named query identifier in the bundle
    cacheKeyPrefix: string;      // Prefix for localStorage cache keys
    displayName: string;         // Human-readable name for logging
    metadataDocPath: string;     // Realtime Database path for metadata
    bundlePath: string;          // Cloud Storage path for bundle files
    collectionName: string;      // Firestore collection name
    collectionPath: string;      // Document listener path pattern
    converter: FirestoreDataConverter<T>;  // Firestore data converter
    shouldTrigger: (beforeData: any, afterData: any) => boolean;  // Trigger logic
    orderByField?: string;       // Optional field to order results
    whereConditions?: Array<{    // Optional query filters
        field: string; 
        operator: any; 
        value: any;
    }>;
}
```

### Current Bundle Types

#### Topics Bundle
```typescript
export const TOPIC_BUNDLE_CONFIG: BundleConfig<Topic> = {
    bundleType: 'topics',
    functionName: 'createtopicbundle',
    namedQuery: 'latest-topics-query',
    cacheKeyPrefix: 'topic',
    displayName: 'topics',
    metadataDocPath: 'bundle-metadata/topic-bundle',
    bundlePath: 'bundles/topics-bundle.bin',
    collectionName: 'topics',
    collectionPath: 'topics/{topicId}',
    converter: firestoreAdminTopicConverter,
    shouldTrigger: () => true,
    orderByField: 'title',
};
```

#### Subtitles Bundle (Category Lists)
```typescript
export const SUBTITLE_BUNDLE_CONFIG: BundleConfig<List> = {
    bundleType: 'subtitles',
    functionName: 'createsubtitlebundle',
    namedQuery: 'latest-subtitles-query',
    cacheKeyPrefix: 'subtitle',
    displayName: 'subtitles',
    metadataDocPath: 'bundle-metadata/subtitle-bundle',
    bundlePath: 'bundles/subtitles-bundle.bin',
    collectionName: 'lists',
    collectionPath: 'lists/{listId}',
    converter: firestoreAdminListConverter,
    shouldTrigger: (beforeData: List | undefined, afterData: List | undefined): boolean => {
        return (beforeData?.type === ListType.CATEGORY_LIST) || 
               (afterData?.type === ListType.CATEGORY_LIST);
    },
    orderByField: 'name',
    whereConditions: [
        { field: 'type', operator: '==', value: ListType.CATEGORY_LIST }
    ]
};
```

#### Bible Chapters Bundle
```typescript
export const BIBLE_CHAPTER_BUNDLE_CONFIG: BundleConfig<List> = {
    bundleType: 'bible-chapters',
    functionName: 'createbiblechapterbundle',
    namedQuery: 'latest-bible-chapters-query',
    cacheKeyPrefix: 'bible-chapter',
    displayName: 'bible chapters',
    metadataDocPath: 'bundle-metadata/bible-chapter-bundle',
    bundlePath: 'bundles/bible-chapters-bundle.bin',
    collectionName: 'lists',
    collectionPath: 'lists/{listId}',
    converter: firestoreAdminListConverter,
    shouldTrigger: (beforeData: List | undefined, afterData: List | undefined): boolean => {
        return (beforeData?.listTagAndPosition?.listTag === ListTag.BIBLE_CHAPTER) ||
               (afterData?.listTagAndPosition?.listTag === ListTag.BIBLE_CHAPTER);
    },
    orderByField: 'listTagAndPosition.position',
    whereConditions: [
        { field: 'listTagAndPosition.listTag', operator: '==', value: ListTag.BIBLE_CHAPTER }
    ]
};
```

#### Sunday Homilies Bundle
```typescript
export const SUNDAY_HOMILY_BUNDLE_CONFIG: BundleConfig<List> = {
    bundleType: 'sunday-homilies',
    functionName: 'createsundayhomilybundle',
    namedQuery: 'latest-sunday-homilies-query',
    cacheKeyPrefix: 'sunday-homily',
    displayName: 'sunday homilies',
    metadataDocPath: 'bundle-metadata/sunday-homily-bundle',
    bundlePath: 'bundles/sunday-homilies-bundle.bin',
    collectionName: 'lists',
    collectionPath: 'lists/{listId}',
    converter: firestoreAdminListConverter,
    shouldTrigger: (beforeData: List | undefined, afterData: List | undefined): boolean => {
        return (beforeData?.listTagAndPosition?.listTag === ListTag.SUNDAY_HOMILY_MONTH) ||
               (afterData?.listTagAndPosition?.listTag === ListTag.SUNDAY_HOMILY_MONTH);
    },
    orderByField: 'listTagAndPosition.position',
    whereConditions: [
        { field: 'listTagAndPosition.listTag', operator: '==', value: ListTag.SUNDAY_HOMILY_MONTH }
    ]
};
```

## Server-side Implementation

### Bundle Creation Utilities

The server-side uses generic utilities in `functions/src/utils/bundleCreationUtils.ts`:

#### Core Functions

```typescript
// Serves existing bundles from Cloud Storage
export async function serveBundleFromStorage<T>(
    config: BundleConfig<T>,
    response: any
): Promise<boolean>

// Generates new bundles and stores them
export async function generateAndStoreBundle<T>(
    config: BundleConfig<T>,
    response?: any
): Promise<number>

// Main HTTP handler for bundle requests
export async function createBundleHandler<T>(
    config: BundleConfig<T>,
    request: any,
    response: any
): Promise<void>
```

### Cloud Functions

Each bundle type has a dedicated Cloud Function that uses the generic handler:

```typescript
// functions/src/createTopicBundle.ts
import { onRequest } from 'firebase-functions/v2/https';
import { createBundleHandler } from './utils/bundleCreationUtils';
import { TOPIC_BUNDLE_CONFIG } from '../../shared/bundleConfigs';

export const createtopicbundle = onRequest({}, async (request, response) => {
    await createBundleHandler(TOPIC_BUNDLE_CONFIG, request, response);
});
```

### Document Listeners

Generic document listeners automatically regenerate bundles when data changes:

```typescript
// functions/src/utils/bundleListenerUtils.ts
export function createBundleDocumentListener<T>(config: BundleConfig<T>) {
    return firestore.onDocumentWritten(
        config.collectionPath,
        async (event) => {
            const beforeData = event.data?.before?.data();
            const afterData = event.data?.after?.data();

            if (!config.shouldTrigger(beforeData, afterData)) {
                return;
            }

            logger.info(`Regenerating ${config.displayName} bundle.`);
            
            const count = await generateAndStoreBundle(config);
            
            await database.ref(config.metadataDocPath).update({
                lastUpdated: Date.now(),
                [`${config.bundleType}-count`]: count,
            });
        }
    );
}
```

## Client-side Implementation

### BundleManager Class

The `BundleManager<T>` class provides a generic, type-safe interface for working with bundles:

```typescript
export class BundleManager<T> {
    // Singleton pattern with type safety
    public static getInstance<T>(config: BundleConfig<T>): BundleManager<T>
    
    // Main data retrieval method
    public async getData(): Promise<T[]>
    
    // Check for available updates
    public async checkForUpdates(): Promise<boolean>
    
    // Preload bundles in background
    public async preloadIfNeeded(): Promise<void>
    
    // Cache management
    public clearCache(): void
    public getCacheStatus(): CacheStatus
}
```

#### Key Features

- **Automatic Caching**: Uses localStorage and memory caching
- **Consistent Logging**: All log messages use format `[BundleManager: displayName] message`
- **Fallback Strategy**: Falls back to cached data if bundle loading fails
- **Race Condition Protection**: Prevents duplicate simultaneous requests
- **Metadata Tracking**: Reduces unnecessary Firestore reads

### Helper Functions

The `utils/bundleHelpers.ts` file provides convenient access functions:

```typescript
// Data retrieval
export const getTopicsFromBundle = async (): Promise<Topic[]>
export const getSubtitlesFromBundle = async (): Promise<List[]>
export const getBibleChaptersFromBundle = async (): Promise<List[]>
export const getSundayHomiliesFromBundle = async (): Promise<List[]>

// Cache management
export const clearAllBundleCaches = (): void
export const preloadAllBundlesIfNeeded = async (): Promise<void>
export const getAllBundleCacheStatus = () => CacheStatusMap

// Update checking
export const checkTopicBundleUpdates = async (): Promise<boolean>
export const checkSubtitleBundleUpdates = async (): Promise<boolean>
// ... etc
```

## Usage Examples

### Basic Data Retrieval

```typescript
import { BundleManager } from '../utils/bundleManager';
import { TOPIC_BUNDLE_CONFIG } from '../shared/bundleConfigs';

// Using BundleManager directly
const topicManager = BundleManager.getInstance<Topic>(TOPIC_BUNDLE_CONFIG);
const topics = await topicManager.getData();

// Using helper functions
import { getTopicsFromBundle } from '../utils/bundleHelpers';
const topics = await getTopicsFromBundle();
```

### In React Components

```tsx
import { useEffect, useState } from 'react';
import { getSubtitlesFromBundle } from '../utils/bundleHelpers';
import { List } from '../types/List';

function SubtitleSelector() {
    const [subtitles, setSubtitles] = useState<List[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const loadSubtitles = async () => {
            try {
                const data = await getSubtitlesFromBundle();
                setSubtitles(data);
            } catch (error) {
                console.error('Failed to load subtitles:', error);
            } finally {
                setLoading(false);
            }
        };

        loadSubtitles();
    }, []);

    // Component render logic...
}
```

### Cache Management

```typescript
import { 
    clearAllBundleCaches, 
    preloadAllBundlesIfNeeded,
    getAllBundleCacheStatus 
} from '../utils/bundleHelpers';

// Clear all caches
clearAllBundleCaches();

// Preload bundles in background
await preloadAllBundlesIfNeeded();

// Check cache status
const status = getAllBundleCacheStatus();
console.log('Topics cache size:', status.topics.cacheSize);
console.log('Is subtitles loading:', status.subtitles.isLoading);
```

## UI Components

### BundleListSelector

Enhanced list selector that uses bundles for topics and subtitles:

```tsx
<BundleListSelector 
  sermonList={sermonList} 
  setSermonList={setSermonList} 
  listType={ListType.TOPIC_LIST} 
/>
```

### Specialized Selectors

```tsx
// Bible chapters (when subtitle is "Bible Studies")
<BibleChapterSelector 
  sermonSubtitle={sermon.subtitle}
  setSermonList={setSermonList}
  selectedChapter={selectedChapter}
  setSelectedChapter={setSelectedChapter}
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
/>
```

## Deployment

Deploy bundle functions individually when changed:

```bash
firebase deploy --only functions:createtopicbundle,functions:createsubtitlebundle,functions:createbiblechapterbundle,functions:createsundayhomilybundle
```

Deploy document listeners:

```bash
firebase deploy --only functions:topiconwrite,functions:subtitlelistonwrite,functions:taggedlistonwrite
```

## Storage and Metadata

### Cloud Storage Structure
```
bundles/
├── topics-bundle.bin
├── subtitles-bundle.bin
├── bible-chapters-bundle.bin
└── sunday-homilies-bundle.bin
```

### Realtime Database Metadata
```
bundle-metadata/
├── topic-bundle/
│   ├── lastUpdated: timestamp
│   ├── topics-count: number
│   └── storagePath: string
├── subtitle-bundle/
│   ├── lastUpdated: timestamp
│   ├── subtitles-count: number
│   └── storagePath: string
└── ...
```

## Adding New Bundle Types

To add a new bundle type, follow this pattern:

1. **Add Configuration** in `shared/bundleConfigs.ts`
2. **Create Cloud Function** using `createBundleHandler`
3. **Add Document Listener** using `createBundleDocumentListener`
4. **Add Helper Functions** in `utils/bundleHelpers.ts`
5. **Update UI Components** as needed

Example for a new "authors" bundle:

```typescript
// 1. Configuration
export const AUTHOR_BUNDLE_CONFIG: BundleConfig<Author> = {
    bundleType: 'authors',
    functionName: 'createauthorbundle',
    namedQuery: 'latest-authors-query',
    cacheKeyPrefix: 'author',
    displayName: 'authors',
    metadataDocPath: 'bundle-metadata/author-bundle',
    bundlePath: 'bundles/authors-bundle.bin',
    collectionName: 'authors',
    collectionPath: 'authors/{authorId}',
    converter: firestoreAdminAuthorConverter,
    shouldTrigger: () => true,
    orderByField: 'name',
};

// 2. Cloud Function
export const createauthorbundle = onRequest({}, async (request, response) => {
    await createBundleHandler(AUTHOR_BUNDLE_CONFIG, request, response);
});

// 3. Document Listener
const authorOnWrite = createBundleDocumentListener(AUTHOR_BUNDLE_CONFIG);
export default authorOnWrite;

// 4. Helper Function
export const getAuthorsFromBundle = async (): Promise<Author[]> => {
    const manager = BundleManager.getInstance<Author>(AUTHOR_BUNDLE_CONFIG);
    return manager.getData();
};
```

## Monitoring and Debugging

### Logging
All bundle operations use consistent logging with the format:
```
[BundleManager: displayName] message
```

### Console Methods
- View cache status: `getAllBundleCacheStatus()`
- Clear caches: `clearAllBundleCaches()`
- Force refresh: `manager.getData()` after `manager.clearCache()`

### Firebase Console
- Monitor Cloud Function executions
- Check Cloud Storage for bundle files
- View Realtime Database for metadata
- Review function logs for bundle generation

## Environment Configuration

Set the Firebase Functions URL:
```
NEXT_PUBLIC_FIREBASE_FUNCTIONS_URL=https://us-central1-your-project.cloudfunctions.net
```

The system automatically detects development/emulator mode and adjusts URLs accordingly.

## Performance Considerations

- Bundle files are served with appropriate cache headers
- Metadata checks are optimized to reduce Firestore reads
- localStorage is used for client-side caching with size limits (1MB)
- Background preloading prevents blocking user interactions
- Fallback strategies ensure the app remains functional even if bundles fail

## Error Handling

The system includes comprehensive error handling:
- Automatic fallback to cached data
- Graceful degradation to Firestore queries
- Detailed error logging with context
- Race condition protection
- Metadata consistency validation 