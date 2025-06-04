import firestore, { loadBundle, namedQuery, getDocsFromCache } from '../firebase/firestore';

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
}

export class BundleManager<T> {
    private static instances: Map<string, BundleManager<any>> = new Map();
    private cachedData: T[] | null = null;
    private lastBundleTimestamp: number | null = null;
    private readonly cacheKey: string;
    private readonly dataCacheKey: string;
    private readonly config: BundleConfig;

    private constructor(config: BundleConfig) {
        this.config = config;
        this.cacheKey = `${config.cacheKeyPrefix}-bundle-timestamp`;
        this.dataCacheKey = `cached-${config.cacheKeyPrefix}`;
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
            // Return cached data if available and not forcing refresh
            if (this.cachedData && !forceRefresh) {
                console.log(`Using cached ${this.config.displayName} from memory (${this.cachedData.length} items)`);
                return this.cachedData;
            }

            console.log(`Fetching ${this.config.displayName} bundle from server...`);

            // Fetch bundle from server (will serve from storage cache)
            const { buffer, timestamp, source } = await this.fetchBundleFromServer();

            // Only reload if we have a newer bundle or no cache
            if (forceRefresh || this.shouldFetchNewBundle(timestamp)) {
                // Load bundle into Firestore cache
                await this.loadBundleIntoFirestore(buffer);

                // Get data from the bundle
                const data = await this.getDataFromBundle();

                // Update our cache
                this.cachedData = data;
                this.lastBundleTimestamp = timestamp;

                // Store in localStorage as backup
                localStorage.setItem(this.cacheKey, timestamp.toString());
                localStorage.setItem(this.dataCacheKey, JSON.stringify(data));

                console.log(`Successfully loaded ${data.length} ${this.config.displayName} from ${source} bundle`);
                return data;
            } else {
                console.log(`${this.config.displayName} bundle unchanged, using existing cache`);
                return this.cachedData || [];
            }

        } catch (error) {
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

    public clearCache(): void {
        this.cachedData = null;
        this.lastBundleTimestamp = null;
        localStorage.removeItem(this.cacheKey);
        localStorage.removeItem(this.dataCacheKey);
        console.log(`${this.config.displayName} bundle cache cleared`);
    }

    public async checkForUpdates(): Promise<boolean> {
        try {
            const { timestamp } = await this.fetchBundleFromServer();
            return this.shouldFetchNewBundle(timestamp);
        } catch (error) {
            console.error(`Error checking for ${this.config.displayName} bundle updates:`, error);
            return false;
        }
    }

    public getCacheStatus(): { hasCachedData: boolean; lastTimestamp: number | null; cacheSize: number } {
        return {
            hasCachedData: this.cachedData !== null,
            lastTimestamp: this.lastBundleTimestamp,
            cacheSize: this.cachedData?.length || 0
        };
    }
} 