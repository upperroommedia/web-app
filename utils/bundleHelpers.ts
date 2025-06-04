import { BundleManager } from './bundleManager';
import {
    TOPIC_BUNDLE_CONFIG,
    SUBTITLE_BUNDLE_CONFIG,
    BIBLE_CHAPTER_BUNDLE_CONFIG,
    SUNDAY_HOMILY_BUNDLE_CONFIG
} from './bundleConfigs';
import { Topic } from '../types/Topic';
import { List } from '../types/List';

// Convenience functions for getting bundle managers
export const getTopicBundleManager = (): BundleManager<Topic> => {
    return BundleManager.getInstance<Topic>(TOPIC_BUNDLE_CONFIG);
};

export const getSubtitleBundleManager = (): BundleManager<List> => {
    return BundleManager.getInstance<List>(SUBTITLE_BUNDLE_CONFIG);
};

export const getBibleChapterBundleManager = (): BundleManager<List> => {
    return BundleManager.getInstance<List>(BIBLE_CHAPTER_BUNDLE_CONFIG);
};

export const getSundayHomilyBundleManager = (): BundleManager<List> => {
    return BundleManager.getInstance<List>(SUNDAY_HOMILY_BUNDLE_CONFIG);
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

export const getBibleChaptersFromBundle = async (forceRefresh: boolean = false): Promise<List[]> => {
    const manager = getBibleChapterBundleManager();
    return manager.getData(forceRefresh);
};

export const getSundayHomiliesFromBundle = async (forceRefresh: boolean = false): Promise<List[]> => {
    const manager = getSundayHomilyBundleManager();
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

export const clearBibleChapterBundleCache = (): void => {
    const manager = getBibleChapterBundleManager();
    manager.clearCache();
};

export const clearSundayHomilyBundleCache = (): void => {
    const manager = getSundayHomilyBundleManager();
    manager.clearCache();
};

export const clearAllBundleCaches = (): void => {
    clearTopicBundleCache();
    clearSubtitleBundleCache();
    clearBibleChapterBundleCache();
    clearSundayHomilyBundleCache();
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

export const checkBibleChapterBundleUpdates = async (): Promise<boolean> => {
    const manager = getBibleChapterBundleManager();
    return manager.checkForUpdates();
};

export const checkSundayHomilyBundleUpdates = async (): Promise<boolean> => {
    const manager = getSundayHomilyBundleManager();
    return manager.checkForUpdates();
}; 