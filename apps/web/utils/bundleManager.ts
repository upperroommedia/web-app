import firestore, { loadBundle, namedQuery, getDocsFromCache } from '../firebase/firestore';
import database, { ref, get } from '../firebase/database';
import { BundleConfig } from '../shared/bundleConfigs';
import { getFirebaseFunctionsBaseUrl, getFirebaseFunctionsEmulatorBaseUrl } from '../shared/firebaseProjectConfig';

export interface BundleMetadata {
  lastUpdated: number;
  count: number;
  storagePath: string;
  createdAt: unknown;
}

export class BundleManager<T> {
  private static instances: Map<string, BundleManager<unknown>> = new Map();
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
    }

    // Initialize cached data from localStorage if available
    const cachedDataJson = localStorage.getItem(this.dataCacheKey);
    if (cachedDataJson) {
      try {
        this.cachedData = JSON.parse(cachedDataJson) as T[];
      } catch (parseError) {
        console.error(
          `[${this.config.displayName}] Error parsing cached data from localStorage during initialization:`,
          parseError
        );
        localStorage.removeItem(this.dataCacheKey);
      }
    }
  }

  private log(message: string): void {
    console.warn(`[BundleManager: ${this.config.displayName}] ${message}`);
  }

  public static getInstance<T>(config: BundleConfig<T>): BundleManager<T> {
    if (!BundleManager.instances.has(config.bundleType)) {
      BundleManager.instances.set(config.bundleType, new BundleManager<T>(config) as BundleManager<unknown>);
    }
    return BundleManager.instances.get(config.bundleType)! as BundleManager<T>;
  }

  private getBundleUrl(): string {
    // Check if we're in development/emulator mode
    const isDevelopment =
      process.env.NODE_ENV === 'development' ||
      process.env.NEXT_PUBLIC_NODE_ENV === 'development' ||
      window.location.hostname === 'localhost';

    if (isDevelopment) {
      // Use emulator URL
      return `${getFirebaseFunctionsEmulatorBaseUrl()}/${this.config.functionName}`;
    } else {
      // Use production URL
      return `${getFirebaseFunctionsBaseUrl()}/${this.config.functionName}`;
    }
  }

  private async fetchBundleFromServer(): Promise<{ buffer: ArrayBuffer; timestamp: number; source: string }> {
    const bundleUrl = this.getBundleUrl();

    const response = await fetch(bundleUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/octet-stream',
      },
      cache: 'no-cache', // Disable browser HTTP cache to force fresh bundle
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${this.config.displayName} bundle: ${response.status} ${response.statusText} from ${bundleUrl}`
      );
    }

    const bundleTimestamp = parseInt(response.headers.get('X-Bundle-Timestamp') || Date.now().toString());
    const bundleSource = response.headers.get('X-Bundle-Source') || 'unknown';

    return {
      buffer: await response.arrayBuffer(),
      timestamp: bundleTimestamp,
      source: bundleSource,
    };
  }

  private async loadBundleIntoFirestore(bundleBuffer: ArrayBuffer): Promise<void> {
    try {
      await loadBundle(firestore, bundleBuffer);
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

      // Execute the query against the cache
      const snapshot = await getDocsFromCache(query);
      const data = snapshot.docs.map((doc) => {
        const docData = doc.data() as T;
        return { ...docData, id: doc.id };
      });

      return data;
    } catch (error) {
      console.error(`[${this.config.displayName}] Error getting data from bundle:`, error);
      throw error;
    }
  }

  private async checkBundleMetadata(): Promise<number | null> {
    try {
      const metadataRef = ref(database, this.config.metadataDocPath);
      const snapshot = await get(metadataRef);
      const metadata = snapshot.val();

      if (metadata) {
        const serverTimestamp = metadata.lastUpdated;

        return serverTimestamp;
      } else {
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
      return true;
    }

    // Fetch if server has a newer version
    const isNewer = serverTimestamp > this.lastBundleTimestamp;
    return isNewer;
  }

  public async getData(): Promise<T[]> {
    try {
      // If already loading and not forcing refresh, return the existing promise
      if (this.loadingPromise) {
        return this.loadingPromise;
      }

      // Check metadata first (with caching)
      const serverTimestamp = await this.checkBundleMetadata();
      // If no metadata exists, fetch bundle to create it
      if (this.shouldFetchNewBundle(serverTimestamp)) {
        this.loadingPromise = this.loadFreshBundle();
        const result = await this.loadingPromise;
        this.loadingPromise = null;
        return result;
      }
      if (!this.cachedData) {
        this.loadingPromise = this.loadFreshBundle();
        const result = await this.loadingPromise;
        this.loadingPromise = null;
        return result;
      }
      return this.cachedData;
    } catch (error) {
      // Clear loading promise on error
      this.loadingPromise = null;

      console.warn(`Error loading ${this.config.displayName} from bundle:`, error);

      // Fallback to cached data if available
      if (this.cachedData) {
        return this.cachedData;
      }

      // Fallback to localStorage cache
      const cachedDataJson = localStorage.getItem(this.dataCacheKey);
      if (cachedDataJson) {
        try {
          const cachedData = JSON.parse(cachedDataJson) as T[];
          this.cachedData = cachedData;
          return cachedData;
        } catch (parseError) {
          console.warn(`Error parsing cached ${this.config.displayName} from localStorage:`, parseError);
          localStorage.removeItem(this.dataCacheKey);
        }
      }

      throw error;
    }
  }

  private async loadFreshBundle(): Promise<T[]> {
    const { buffer, timestamp } = await this.fetchBundleFromServer();

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
      if (dataString.length < 1024 * 1024) {
        // 1MB limit
        localStorage.setItem(this.dataCacheKey, dataString);
      } else {
        localStorage.removeItem(this.dataCacheKey);
      }
    } catch (e) {
      console.warn(`Failed to store ${this.config.displayName} in localStorage:`, e);
      localStorage.removeItem(this.dataCacheKey);
    }

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
  }

  private async validateBundleConsistency(bundleTimestamp: number): Promise<void> {
    // Verify that the bundle timestamp matches what we expect from metadata
    if (this.cachedMetadataTimestamp && Math.abs(bundleTimestamp - this.cachedMetadataTimestamp) > 60000) {
      // 1 minute tolerance
      console.warn(
        `Bundle timestamp mismatch for ${this.config.displayName}: bundle=${bundleTimestamp}, metadata=${this.cachedMetadataTimestamp}`
      );
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
      hasLocalStorageBackup,
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
        this.loadingPromise = this.loadFreshBundle();
        await this.loadingPromise;
        this.loadingPromise = null;
      }
    } catch (error) {
      this.loadingPromise = null;
      this.log(`Background preload failed: ${error}`);
      // Don't throw - this is a background operation
    }
  }
}
