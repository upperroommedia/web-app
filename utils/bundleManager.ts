import firestore, { loadBundle, namedQuery, getDocsFromCache, doc, getDoc } from '../firebase/firestore';

export interface BundleMetadata {
    lastUpdated: number;
    count: number;
    storagePath: string;
    createdAt: any;
}

export interface BundleConfig {
    bundleType: string;
    functionName: string;
    namedQuery: string;
    cacheKeyPrefix: string;
    displayName: string;
    metadataDocPath: string;
}

export class BundleManager<T> {
    private static instances: Map<string, BundleManager<any>> = new Map();
    private cachedData: T[] | null = null;
    private lastBundleTimestamp: number | null = null;
    private readonly cacheKey: string;
    private readonly dataCacheKey: string;
    private readonly config: BundleConfig;

    // Race condition protection
    private loadingPromise: Promise<T[]> | null = null;

    // Metadata caching to reduce Firestore reads
    private lastMetadataCheck: number | null = null;
    private cachedMetadataTimestamp: number | null = null;
    private readonly METADATA_CACHE_TTL = 30000; // 30 seconds

    private constructor(config: BundleConfig) {
        this.config = config;
        this.cacheKey = `${config.cacheKeyPrefix}-bundle-timestamp`;
        this.dataCacheKey = `cached-${config.cacheKeyPrefix}`;

        // Initialize timestamp from localStorage if available
        const storedTimestamp = localStorage.getItem(this.cacheKey);
        if (storedTimestamp) {
            this.lastBundleTimestamp = parseInt(storedTimestamp);
            console.log(`Initialized ${config.displayName} bundle manager with cached timestamp: ${this.lastBundleTimestamp}`);
        }
    }

    public static getInstance<T>(config: BundleConfig): BundleManager<T> {
        if (!BundleManager.instances.has(config.bundleType)) {
            BundleManager.instances.set(config.bundleType, new BundleManager<T>(config));
        }
        return BundleManager.instances.get(config.bundleType)!;
    }

    private getBundleUrl(): string {
        // Check if we're in development/emulator mode
        const isDevelopment = process.env.NODE_ENV === 'development' ||
            process.env.NEXT_PUBLIC_NODE_ENV === 'development' ||
            window.location.hostname === 'localhost';

        if (isDevelopment) {
            // Use emulator URL
            return `http://localhost:5001/urm-app/us-central1/${this.config.functionName}`;
        } else {
            // Use production URL
            const functionsUrl = process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_URL ||
                'https://us-central1-urm-app.cloudfunctions.net';
            return `${functionsUrl}/${this.config.functionName}`;
        }
    }

    private async fetchBundleFromServer(): Promise<{ buffer: ArrayBuffer; timestamp: number; source: string }> {
        const bundleUrl = this.getBundleUrl();
        console.log(`Fetching ${this.config.displayName} bundle from: ${bundleUrl}`);

        const response = await fetch(bundleUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/octet-stream',
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch ${this.config.displayName} bundle: ${response.status} ${response.statusText} from ${bundleUrl}`);
        }

        const bundleTimestamp = parseInt(response.headers.get('X-Bundle-Timestamp') || Date.now().toString());
        const bundleSource = response.headers.get('X-Bundle-Source') || 'unknown';

        console.log(`${this.config.displayName} bundle fetched from: ${bundleSource} (timestamp: ${bundleTimestamp})`);

        return {
            buffer: await response.arrayBuffer(),
            timestamp: bundleTimestamp,
            source: bundleSource
        };
    }

    private async loadBundleIntoFirestore(bundleBuffer: ArrayBuffer): Promise<void> {
        try {
            console.log(`Loading ${this.config.displayName} bundle into Firestore (${bundleBuffer.byteLength} bytes)`);
            const loadTask = loadBundle(firestore, bundleBuffer);

            // Wait for the bundle to load
            const progress = await loadTask;
            console.log(`${this.config.displayName} bundle loaded successfully. Documents loaded: ${progress.documentsLoaded}, Bytes loaded: ${progress.bytesLoaded}`);

        } catch (error) {
            console.error(`Error loading ${this.config.displayName} bundle into Firestore:`, error);
            throw error;
        }
    }

    private async getDataFromBundle(): Promise<T[]> {
        try {
            // Get the named query from the bundle
            const query = await namedQuery(firestore, this.config.namedQuery);
            if (!query) {
                throw new Error(`Named query "${this.config.namedQuery}" not found in bundle`);
            }

            console.log(`Executing named query from ${this.config.displayName} bundle...`);

            // Execute the query against the cache
            const snapshot = await getDocsFromCache(query);
            const data = snapshot.docs.map(doc => {
                const docData = doc.data() as T;
                return { ...docData, id: doc.id };
            });

            console.log(`Retrieved ${data.length} ${this.config.displayName} from bundle cache`);
            return data;

        } catch (error) {
            console.error(`Error getting ${this.config.displayName} from bundle:`, error);
            throw error;
        }
    }

    private async checkBundleMetadata(): Promise<number | null> {
        try {
            const now = Date.now();

            // Use cached metadata if it's still fresh
            if (this.lastMetadataCheck &&
                this.cachedMetadataTimestamp !== null &&
                (now - this.lastMetadataCheck) < this.METADATA_CACHE_TTL) {
                console.log(`Using cached metadata for ${this.config.displayName} (${Math.round((now - this.lastMetadataCheck) / 1000)}s old)`);
                return this.cachedMetadataTimestamp;
            }

            console.log(`Checking ${this.config.displayName} bundle metadata from Firestore...`);

            const metadataDoc = await getDoc(doc(firestore, this.config.metadataDocPath));

            if (metadataDoc.exists()) {
                const metadata = metadataDoc.data() as BundleMetadata;
                const serverTimestamp = metadata.lastUpdated;

                // Cache the metadata result
                this.lastMetadataCheck = now;
                this.cachedMetadataTimestamp = serverTimestamp;

                console.log(`${this.config.displayName} bundle metadata: server timestamp ${serverTimestamp}, cached timestamp ${this.lastBundleTimestamp}`);
                return serverTimestamp;
            } else {
                // Cache the "not found" result to avoid repeated checks
                this.lastMetadataCheck = now;
                this.cachedMetadataTimestamp = null;

                console.log(`${this.config.displayName} bundle metadata document does not exist`);
                return null;
            }
        } catch (error) {
            console.error(`Error checking ${this.config.displayName} bundle metadata:`, error);

            // Don't cache error results, allow retry
            return null;
        }
    }

    private shouldFetchNewBundle(serverTimestamp: number): boolean {
        // Always fetch if we don't have a cached timestamp
        if (!this.lastBundleTimestamp) {
            console.log(`No cached timestamp for ${this.config.displayName}, fetching new bundle`);
            return true;
        }

        // Fetch if server has a newer version
        const isNewer = serverTimestamp > this.lastBundleTimestamp;
        if (isNewer) {
            console.log(`Server ${this.config.displayName} bundle is newer (${serverTimestamp} > ${this.lastBundleTimestamp}), fetching update`);
        } else {
            console.log(`${this.config.displayName} bundle is up to date (${serverTimestamp} <= ${this.lastBundleTimestamp})`);
        }

        return isNewer;
    }

    public async getData(forceRefresh: boolean = false): Promise<T[]> {
        try {
            // If already loading and not forcing refresh, return the existing promise
            if (this.loadingPromise && !forceRefresh) {
                console.log(`${this.config.displayName} bundle already loading, waiting for existing request...`);
                return this.loadingPromise;
            }

            // If forcing refresh, skip metadata check and fetch new bundle
            if (forceRefresh) {
                console.log(`Force refresh requested for ${this.config.displayName} bundle`);
                this.loadingPromise = this.loadFreshBundle();
                const result = await this.loadingPromise;
                this.loadingPromise = null;
                return result;
            }

            // Check metadata first (with caching)
            const serverTimestamp = await this.checkBundleMetadata();

            // If no metadata exists, fetch bundle to create it
            if (serverTimestamp === null) {
                console.log(`No metadata found for ${this.config.displayName}, fetching bundle...`);
                this.loadingPromise = this.loadFreshBundle();
                const result = await this.loadingPromise;
                this.loadingPromise = null;
                return result;
            }

            // Check if we need to update based on metadata
            const needsUpdate = this.shouldFetchNewBundle(serverTimestamp);

            // If we have cached data and it's up to date, use it
            if (this.cachedData && !needsUpdate) {
                console.log(`Using cached ${this.config.displayName} from memory (${this.cachedData.length} items) - bundle is up to date`);
                return this.cachedData;
            }

            // Need to fetch new bundle
            if (needsUpdate) {
                console.log(`${this.config.displayName} bundle needs update, fetching from server...`);
                this.loadingPromise = this.loadFreshBundle();
                const result = await this.loadingPromise;
                this.loadingPromise = null;
                return result;
            } else {
                // This shouldn't happen based on the logic above, but handle gracefully
                console.log(`${this.config.displayName} bundle unchanged, using existing cache`);
                return this.cachedData || [];
            }

        } catch (error) {
            // Clear loading promise on error
            this.loadingPromise = null;

            console.error(`Error loading ${this.config.displayName} from bundle:`, error);

            // Fallback to cached data if available
            if (this.cachedData) {
                console.log(`Using memory cache as fallback (${this.cachedData.length} ${this.config.displayName})`);
                return this.cachedData;
            }

            // Fallback to localStorage cache
            const cachedDataJson = localStorage.getItem(this.dataCacheKey);
            if (cachedDataJson) {
                try {
                    const cachedData = JSON.parse(cachedDataJson) as T[];
                    this.cachedData = cachedData;
                    console.log(`Using localStorage cache as fallback (${cachedData.length} ${this.config.displayName})`);
                    return cachedData;
                } catch (parseError) {
                    console.error(`Error parsing cached ${this.config.displayName} from localStorage:`, parseError);
                    localStorage.removeItem(this.dataCacheKey);
                }
            }

            throw error;
        }
    }

    private async loadFreshBundle(): Promise<T[]> {
        const { buffer, timestamp, source } = await this.fetchBundleFromServer();

        // Validate bundle consistency
        await this.validateBundleConsistency(timestamp);

        // Load bundle into Firestore cache
        await this.loadBundleIntoFirestore(buffer);

        // Get data from the bundle
        const data = await this.getDataFromBundle();

        // Update our cache
        this.cachedData = data;
        this.lastBundleTimestamp = timestamp;

        // Store only timestamp in localStorage (not full data to save space)
        localStorage.setItem(this.cacheKey, timestamp.toString());

        // Only store data in localStorage if it's reasonably small (< 1MB when stringified)
        try {
            const dataString = JSON.stringify(data);
            if (dataString.length < 1024 * 1024) { // 1MB limit
                localStorage.setItem(this.dataCacheKey, dataString);
            } else {
                console.log(`${this.config.displayName} data too large for localStorage (${Math.round(dataString.length / 1024)}KB), skipping`);
                localStorage.removeItem(this.dataCacheKey);
            }
        } catch (e) {
            console.warn(`Failed to store ${this.config.displayName} in localStorage:`, e);
            localStorage.removeItem(this.dataCacheKey);
        }

        console.log(`Successfully loaded ${data.length} ${this.config.displayName} from ${source} bundle`);
        return data;
    }

    public clearCache(): void {
        this.cachedData = null;
        this.lastBundleTimestamp = null;
        this.loadingPromise = null;
        this.lastMetadataCheck = null;
        this.cachedMetadataTimestamp = null;
        localStorage.removeItem(this.cacheKey);
        localStorage.removeItem(this.dataCacheKey);
        console.log(`${this.config.displayName} bundle cache cleared`);
    }

    private async validateBundleConsistency(bundleTimestamp: number): Promise<void> {
        // Verify that the bundle timestamp matches what we expect from metadata
        if (this.cachedMetadataTimestamp &&
            Math.abs(bundleTimestamp - this.cachedMetadataTimestamp) > 60000) { // 1 minute tolerance
            console.warn(`Bundle timestamp mismatch for ${this.config.displayName}: bundle=${bundleTimestamp}, metadata=${this.cachedMetadataTimestamp}`);
            // Clear metadata cache to force refresh on next check
            this.lastMetadataCheck = null;
            this.cachedMetadataTimestamp = null;
        }
    }

    public async checkForUpdates(): Promise<boolean> {
        try {
            const serverTimestamp = await this.checkBundleMetadata();

            if (serverTimestamp === null) {
                // No metadata means we should fetch the bundle
                return true;
            }

            return this.shouldFetchNewBundle(serverTimestamp);
        } catch (error) {
            console.error(`Error checking for ${this.config.displayName} bundle updates:`, error);
            return false;
        }
    }

    public getCacheStatus(): {
        hasCachedData: boolean;
        lastTimestamp: number | null;
        cacheSize: number;
        isLoading: boolean;
        metadataCacheAge: number | null;
        hasLocalStorageBackup: boolean;
    } {
        const now = Date.now();
        const metadataCacheAge = this.lastMetadataCheck ? now - this.lastMetadataCheck : null;
        const hasLocalStorageBackup = !!localStorage.getItem(this.dataCacheKey);

        return {
            hasCachedData: this.cachedData !== null,
            lastTimestamp: this.lastBundleTimestamp,
            cacheSize: this.cachedData?.length || 0,
            isLoading: this.loadingPromise !== null,
            metadataCacheAge,
            hasLocalStorageBackup
        };
    }

    /**
     * Preload bundle in background if updates are available
     * Useful for warming caches without blocking user interactions
     */
    public async preloadIfNeeded(): Promise<void> {
        try {
            // Don't preload if already loading or we have very recent data
            if (this.loadingPromise) return;

            const serverTimestamp = await this.checkBundleMetadata();
            if (serverTimestamp && this.shouldFetchNewBundle(serverTimestamp)) {
                console.log(`Preloading ${this.config.displayName} bundle in background...`);
                this.loadingPromise = this.loadFreshBundle();
                await this.loadingPromise;
                this.loadingPromise = null;
                console.log(`${this.config.displayName} bundle preloaded successfully`);
            }
        } catch (error) {
            this.loadingPromise = null;
            console.log(`Background preload failed for ${this.config.displayName}:`, error);
            // Don't throw - this is a background operation
        }
    }
} 