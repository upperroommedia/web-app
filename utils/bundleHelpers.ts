import { BundleManager } from './bundleManager';
import { TOPIC_BUNDLE_CONFIG, SUBTITLE_BUNDLE_CONFIG } from './bundleConfigs';
import { Topic } from '../types/Topic';
import { List } from '../types/List';

// Convenience functions for getting bundle managers
export const getTopicBundleManager = (): BundleManager<Topic> => {
    return BundleManager.getInstance<Topic>(TOPIC_BUNDLE_CONFIG);
};

export const getSubtitleBundleManager = (): BundleManager<List> => {
    return BundleManager.getInstance<List>(SUBTITLE_BUNDLE_CONFIG);
};

// Convenience functions for getting data
export const getTopicsFromBundle = async (forceRefresh: boolean = false): Promise<Topic[]> => {
    const manager = getTopicBundleManager();
    return manager.getData(forceRefresh);
};

export const getSubtitlesFromBundle = async (forceRefresh: boolean = false): Promise<List[]> => {
    const manager = getSubtitleBundleManager();
    return manager.getData(forceRefresh);
};

// Convenience functions for cache management
export const clearTopicBundleCache = (): void => {
    const manager = getTopicBundleManager();
    manager.clearCache();
};

export const clearSubtitleBundleCache = (): void => {
    const manager = getSubtitleBundleManager();
    manager.clearCache();
};

export const clearAllBundleCaches = (): void => {
    clearTopicBundleCache();
    clearSubtitleBundleCache();
};

// Convenience functions for checking updates
export const checkTopicBundleUpdates = async (): Promise<boolean> => {
    const manager = getTopicBundleManager();
    return manager.checkForUpdates();
};

export const checkSubtitleBundleUpdates = async (): Promise<boolean> => {
    const manager = getSubtitleBundleManager();
    return manager.checkForUpdates();
}; 