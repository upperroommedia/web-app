import firestore, { loadBundle, namedQuery, getDocsFromCache, doc, getDoc } from '../firebase/firestore';
import database, { ref, get } from '../firebase/database';
import { BundleConfig } from '../shared/bundleConfigs';

export interface BundleMetadata {
    lastUpdated: number;
    count: number;
    storagePath: string;
    createdAt: any;
}

export class BundleManager<T> {
    private static instances: Map<string, BundleManager<any>> = new Map();
    private cachedData: T[] | null = null;
    private lastBundleTimestamp: number | null = null;
    private readonly cacheKey: string;
    private readonly dataCacheKey: string;
    private readonly config: BundleConfig<T>;

    // Race condition protection
    private loadingPromise: Promise<T[]> | null = null;

    // Metadata caching to reduce Firestore reads
    private lastMetadataCheck: number | null = null;
    private cachedMetadataTimestamp: number | null = null;

    private constructor(config: BundleConfig<T>) {
        this.config = config;
        this.cacheKey = `${config.cacheKeyPrefix}-bundle-timestamp`;
        this.dataCacheKey = `cached-${config.cacheKeyPrefix}`;

        // Initialize timestamp from localStorage if available
        const storedTimestamp = localStorage.getItem(this.cacheKey);
        if (storedTimestamp) {
            this.lastBundleTimestamp = parseInt(storedTimestamp);
            this.log(`Initialized bundle manager with cached timestamp: ${new Date(this.lastBundleTimestamp).toISOString()}`);
        }

        // Initialize cached data from localStorage if available
        const cachedDataJson = localStorage.getItem(this.dataCacheKey);
        if (cachedDataJson) {
            try {
                this.cachedData = JSON.parse(cachedDataJson) as T[];
                this.log(`Initialized bundle manager with cached data: ${this.cachedData.length} items`);
            } catch (parseError) {
                console.error(`[${this.config.displayName}] Error parsing cached data from localStorage during initialization:`, parseError);
                localStorage.removeItem(this.dataCacheKey);
            }
        }
    }

    private log(message: string): void {
        console.log(`[BundleManager: ${this.config.displayName}] ${message}`);
    }

    public static getInstance<T>(config: BundleConfig<T>): BundleManager<T> {
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
        this.log(`Fetching bundle from: ${bundleUrl}`);

        const response = await fetch(bundleUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/octet-stream',
            },
            cache: 'no-cache' // Disable browser HTTP cache to force fresh bundle
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch ${this.config.displayName} bundle: ${response.status} ${response.statusText} from ${bundleUrl}`);
        }

        const bundleTimestamp = parseInt(response.headers.get('X-Bundle-Timestamp') || Date.now().toString());
        const bundleSource = response.headers.get('X-Bundle-Source') || 'unknown';

        this.log(`bundle fetched from: ${bundleSource} (timestamp: ${new Date(bundleTimestamp).toISOString()})`);

        return {
            buffer: await response.arrayBuffer(),
            timestamp: bundleTimestamp,
            source: bundleSource
        };
    }

    private async loadBundleIntoFirestore(bundleBuffer: ArrayBuffer): Promise<void> {
        try {
            this.log(`Loading bundle into Firestore (${bundleBuffer.byteLength} bytes)`);
            const loadTask = loadBundle(firestore, bundleBuffer);

            // Wait for the bundle to load
            const progress = await loadTask;
            this.log(`bundle loaded successfully. Documents loaded: ${progress.documentsLoaded}, Bytes loaded: ${progress.bytesLoaded}`);

        } catch (error) {
            console.error(`[${this.config.displayName}] Error loading bundle into Firestore:`, error);
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

            this.log(`Executing named query from bundle...`);

            // Execute the query against the cache
            const snapshot = await getDocsFromCache(query);
            const data = snapshot.docs.map(doc => {
                this.log(`doc data: ${JSON.stringify(doc.data().title)}`);
                const docData = doc.data() as T;
                return { ...docData, id: doc.id };
            });

            this.log(`Retrieved ${data.length} from bundle cache`);
            return data;

        } catch (error) {
            console.error(`[${this.config.displayName}] Error getting data from bundle:`, error);
            throw error;
        }
    }

    private async checkBundleMetadata(): Promise<number | null> {
        try {
            this.log(`Checking bundle metadata from Realtime Database...`);

            const metadataRef = ref(database, this.config.metadataDocPath);
            const snapshot = await get(metadataRef);
            const metadata = snapshot.val();

            if (metadata) {
                const serverTimestamp = metadata.lastUpdated;

                this.log(`bundle metadata: server timestamp ${new Date(serverTimestamp).toISOString()}, cached timestamp ${new Date(this.lastBundleTimestamp || 0).toISOString()}`);
                return serverTimestamp;
            } else {
                this.log(`bundle metadata does not exist`);
                return null;
            }
        } catch (error) {
            console.error(`Error checking ${this.config.displayName} bundle metadata:`, error);
            return null;
        }
    }

    private shouldFetchNewBundle(serverTimestamp: number | null): boolean {
        // Always fetch if we don't have a cached timestamp
        if (!this.lastBundleTimestamp || !serverTimestamp || !this.cachedData) {
            if (!this.lastBundleTimestamp) {
                this.log(`bundle is not initialized, fetching new bundle`);
            } else if (!serverTimestamp) {
                this.log(`bundle has no server timestamp, fetching new bundle`);
            } else if (!this.cachedData) {
                this.log(`bundle has no cached data, fetching new bundle`);
            }
            return true;
        }

        // Fetch if server has a newer version
        const isNewer = serverTimestamp > this.lastBundleTimestamp;
        if (isNewer) {
            this.log(`Server bundle is newer (${serverTimestamp} > ${this.lastBundleTimestamp}), fetching update`);
        } else {
            this.log(`bundle is up to date (${serverTimestamp} <= ${this.lastBundleTimestamp})`);
        }

        return isNewer;
    }

    public async getData(): Promise<T[]> {
        try {
            // If already loading and not forcing refresh, return the existing promise
            if (this.loadingPromise) {
                this.log(`bundle already loading, waiting for existing request...`);
                return this.loadingPromise;
            }

            // Check metadata first (with caching)
            const serverTimestamp = await this.checkBundleMetadata();
            this.log(`Server timestamp for bundle: ${serverTimestamp}`);
            // If no metadata exists, fetch bundle to create it
            if (this.shouldFetchNewBundle(serverTimestamp)) {
                this.log(`No metadata found, fetching bundle...`);
                this.loadingPromise = this.loadFreshBundle();
                const result = await this.loadingPromise;
                this.loadingPromise = null;
                return result;
            }
            if (!this.cachedData) {
                this.log(`No cached data, fetching bundle...`);
                this.loadingPromise = this.loadFreshBundle();
                const result = await this.loadingPromise;
                this.loadingPromise = null;
                return result;
            }
            return this.cachedData;

        } catch (error) {
            // Clear loading promise on error
            this.loadingPromise = null;

            console.error(`Error loading ${this.config.displayName} from bundle:`, error);

            // Fallback to cached data if available
            if (this.cachedData) {
                this.log(`Using memory cache as fallback (${this.cachedData.length} items)`);
                return this.cachedData;
            }

            // Fallback to localStorage cache
            const cachedDataJson = localStorage.getItem(this.dataCacheKey);
            if (cachedDataJson) {
                try {
                    const cachedData = JSON.parse(cachedDataJson) as T[];
                    this.cachedData = cachedData;
                    this.log(`Using localStorage cache as fallback (${cachedData.length} items)`);
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
                this.log(`data too large for localStorage (${Math.round(dataString.length / 1024)}KB), skipping`);
                localStorage.removeItem(this.dataCacheKey);
            }
        } catch (e) {
            console.warn(`Failed to store ${this.config.displayName} in localStorage:`, e);
            localStorage.removeItem(this.dataCacheKey);
        }

        this.log(`Successfully loaded ${data.length} items from ${source} bundle`);
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
        this.log(`bundle cache cleared`);
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
                this.log(`Preloading bundle in background...`);
                this.loadingPromise = this.loadFreshBundle();
                await this.loadingPromise;
                this.loadingPromise = null;
                this.log(`bundle preloaded successfully`);
            }
        } catch (error) {
            this.loadingPromise = null;
            this.log(`Background preload failed: ${error}`);
            // Don't throw - this is a background operation
        }
    }
} 