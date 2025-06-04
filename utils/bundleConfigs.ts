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