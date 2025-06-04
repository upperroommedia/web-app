import { BundleConfig } from './bundleManager';

export const TOPIC_BUNDLE_CONFIG: BundleConfig = {
    bundleType: 'topics',
    functionName: 'createtopicbundle',
    namedQuery: 'latest-topics-query',
    cacheKeyPrefix: 'topic',
    displayName: 'topics'
};

export const SUBTITLE_BUNDLE_CONFIG: BundleConfig = {
    bundleType: 'subtitles',
    functionName: 'createsubtitlebundle',
    namedQuery: 'latest-subtitles-query',
    cacheKeyPrefix: 'subtitle',
    displayName: 'subtitles'
};

export const BIBLE_CHAPTER_BUNDLE_CONFIG: BundleConfig = {
    bundleType: 'bible-chapters',
    functionName: 'createbiblechapterbundle',
    namedQuery: 'latest-bible-chapters-query',
    cacheKeyPrefix: 'bible-chapter',
    displayName: 'bible chapters'
};

export const SUNDAY_HOMILY_BUNDLE_CONFIG: BundleConfig = {
    bundleType: 'sunday-homilies',
    functionName: 'createsundayhomilybundle',
    namedQuery: 'latest-sunday-homilies-query',
    cacheKeyPrefix: 'sunday-homily',
    displayName: 'sunday homilies'
}; 