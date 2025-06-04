import Fuse from 'fuse.js';
import type { IFuseOptions, FuseResult } from 'fuse.js';

export interface LocalSearchOptions {
    threshold?: number;
    keys?: string[];
    includeScore?: boolean;
    includeMatches?: boolean;
}

export interface LocalSearchResult<T> {
    item: T;
    score?: number;
    matches?: any[];
}

export interface SearchableItem {
    id: string;
    [key: string]: any;
}

export class LocalSearch<T extends SearchableItem> {
    private fuse: Fuse<T> | null = null;
    private items: T[] = [];
    private searchFieldKey: keyof T;
    private displayName: string;

    constructor(
        items: T[],
        searchFieldKey: keyof T,
        displayName: string,
        options?: LocalSearchOptions
    ) {
        this.items = items;
        this.searchFieldKey = searchFieldKey;
        this.displayName = displayName;
        this.initializeFuse(options);
    }

    private initializeFuse(options?: LocalSearchOptions): void {
        const defaultOptions: IFuseOptions<T> = {
            // Search in the specified field
            keys: options?.keys || [this.searchFieldKey as string],

            // Less strict threshold for better coverage (0.4 is a good middle ground)
            threshold: options?.threshold || 0.4,

            // Include score and matches for debugging
            includeScore: options?.includeScore !== false,
            includeMatches: options?.includeMatches !== false,

            // Minimum characters to match
            minMatchCharLength: 1,

            // Sort results by score
            shouldSort: true,

            // Find all matches in the string, not just the first
            findAllMatches: true,

            // Start searching from the beginning of the string
            location: 0,

            // Increased distance to allow matches further from the start while still favoring early matches
            distance: 200,

            // Case insensitive
            isCaseSensitive: false,

            // Location matters for scoring (early matches score better)
            ignoreLocation: false,

            // Field length norm helps shorter matches score better
            ignoreFieldNorm: false,
        };

        try {
            this.fuse = new Fuse(this.items, defaultOptions);
            console.log(`LocalSearch initialized with ${this.items.length} ${this.displayName}`);
        } catch (error) {
            console.error(`Error initializing Fuse.js for ${this.displayName}:`, error);
            this.fuse = null;
        }
    }

    public search(query: string, limit: number = 50): LocalSearchResult<T>[] {
        if (!this.fuse || !query.trim()) {
            // Return items in original order (already sorted by field from bundle)
            return this.items
                .slice(0, limit)
                .map(item => ({ item }));
        }

        try {
            const results: FuseResult<T>[] = this.fuse.search(query, { limit });

            console.log(`${this.displayName} search for "${query}" found ${results.length} results`);
            if (results.length > 0) {
                console.log(`Top 3 ${this.displayName} results:`, results.slice(0, 3).map(r => ({
                    [this.searchFieldKey]: r.item[this.searchFieldKey],
                    score: r.score
                })));
            }

            return results.map((result) => ({
                item: result.item,
                score: result.score,
                matches: result.matches ? [...result.matches] : undefined
            }));
        } catch (error) {
            console.error(`Error during ${this.displayName} search:`, error);
            return [];
        }
    }

    public updateItems(items: T[], options?: LocalSearchOptions): void {
        this.items = items;
        this.initializeFuse(options);
    }

    public getAllItems(): T[] {
        return this.items;
    }

    public getItemsByIds(ids: string[]): T[] {
        return this.items.filter(item => ids.includes(item.id));
    }

    public searchByField(fieldValue: string, exactMatch: boolean = false): T[] {
        if (exactMatch) {
            return this.items.filter(item =>
                String(item[this.searchFieldKey]).toLowerCase() === fieldValue.toLowerCase()
            );
        }

        return this.search(fieldValue).map(result => result.item);
    }

    public filterItems(filterFn: (item: T) => boolean): T[] {
        return this.items.filter(filterFn);
    }

    public sortItems(
        sortFn: (a: T, b: T) => number = (a, b) =>
            String(a[this.searchFieldKey]).localeCompare(String(b[this.searchFieldKey]))
    ): T[] {
        return [...this.items].sort(sortFn);
    }

    // Debug method to test search configuration
    public testSearch(query: string): void {
        console.log(`Testing ${this.displayName} search for: "${query}"`);
        const results = this.search(query, 5);
        results.forEach((result, index) => {
            console.log(`${index + 1}. "${result.item[this.searchFieldKey]}" (score: ${result.score})`);
        });
    }
} 