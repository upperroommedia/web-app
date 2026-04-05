import { BundleManager } from './bundleManager';
import {
  TOPIC_BUNDLE_CONFIG,
  SUBTITLE_BUNDLE_CONFIG,
  BIBLE_CHAPTER_BUNDLE_CONFIG,
  HOLY_WEEK_BUNDLE_CONFIG,
  SUNDAY_HOMILY_BUNDLE_CONFIG,
  LATEST_LIST_BUNDLE_CONFIG,
} from '../shared/bundleConfigs';
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

export const getHolyWeekBundleManager = (): BundleManager<List> => {
  return BundleManager.getInstance<List>(HOLY_WEEK_BUNDLE_CONFIG);
};

export const getLatestListBundleManager = (): BundleManager<List> => {
  return BundleManager.getInstance<List>(LATEST_LIST_BUNDLE_CONFIG);
};

// Convenience functions for getting data
export const getTopicsFromBundle = async (): Promise<Topic[]> => {
  const manager = getTopicBundleManager();
  return manager.getData();
};

export const getSubtitlesFromBundle = async (): Promise<List[]> => {
  const manager = getSubtitleBundleManager();
  return manager.getData();
};

export const getBibleChaptersFromBundle = async (): Promise<List[]> => {
  const manager = getBibleChapterBundleManager();
  return manager.getData();
};

export const getSundayHomiliesFromBundle = async (): Promise<List[]> => {
  const manager = getSundayHomilyBundleManager();
  return manager.getData();
};

export const getHolyWeekListsFromBundle = async (): Promise<List[]> => {
  const manager = getHolyWeekBundleManager();
  return manager.getData();
};

export const getLatestListFromBundle = async (): Promise<List[]> => {
  const manager = getLatestListBundleManager();
  return manager.getData();
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

export const clearHolyWeekBundleCache = (): void => {
  const manager = getHolyWeekBundleManager();
  manager.clearCache();
};

export const clearLatestListBundleCache = (): void => {
  const manager = getLatestListBundleManager();
  manager.clearCache();
};

export const clearAllBundleCaches = (): void => {
  clearTopicBundleCache();
  clearSubtitleBundleCache();
  clearBibleChapterBundleCache();
  clearSundayHomilyBundleCache();
  clearHolyWeekBundleCache();
  clearLatestListBundleCache();
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

export const checkHolyWeekBundleUpdates = async (): Promise<boolean> => {
  const manager = getHolyWeekBundleManager();
  return manager.checkForUpdates();
};

export const checkLatestListBundleUpdates = async (): Promise<boolean> => {
  const manager = getLatestListBundleManager();
  return manager.checkForUpdates();
};

// Convenience functions for preloading bundles in background
export const preloadTopicBundleIfNeeded = async (): Promise<void> => {
  const manager = getTopicBundleManager();
  return manager.preloadIfNeeded();
};

export const preloadSubtitleBundleIfNeeded = async (): Promise<void> => {
  const manager = getSubtitleBundleManager();
  return manager.preloadIfNeeded();
};

export const preloadBibleChapterBundleIfNeeded = async (): Promise<void> => {
  const manager = getBibleChapterBundleManager();
  return manager.preloadIfNeeded();
};

export const preloadSundayHomilyBundleIfNeeded = async (): Promise<void> => {
  const manager = getSundayHomilyBundleManager();
  return manager.preloadIfNeeded();
};

export const preloadHolyWeekBundleIfNeeded = async (): Promise<void> => {
  const manager = getHolyWeekBundleManager();
  return manager.preloadIfNeeded();
};

export const preloadLatestListIfNeeded = async (): Promise<void> => {
  const manager = getLatestListBundleManager();
  return manager.preloadIfNeeded();
};

export const preloadAllBundlesIfNeeded = async (): Promise<void> => {
  await Promise.all([
    preloadTopicBundleIfNeeded(),
    preloadSubtitleBundleIfNeeded(),
    preloadBibleChapterBundleIfNeeded(),
    preloadSundayHomilyBundleIfNeeded(),
    preloadHolyWeekBundleIfNeeded(),
    preloadLatestListIfNeeded(),
  ]);
};

// Get detailed cache status for all bundles
export const getAllBundleCacheStatus = () => {
  return {
    topics: getTopicBundleManager().getCacheStatus(),
    subtitles: getSubtitleBundleManager().getCacheStatus(),
    bibleChapters: getBibleChapterBundleManager().getCacheStatus(),
    sundayHomilies: getSundayHomilyBundleManager().getCacheStatus(),
    holyWeek: getHolyWeekBundleManager().getCacheStatus(),
    latestList: getLatestListBundleManager().getCacheStatus(),
  };
};
