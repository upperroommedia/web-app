import { BundleConfig } from './bundleManager';
import { BUNDLE_METADATA_PATHS, NAMED_QUERIES } from '../shared/bundleConstants';

export const TOPIC_BUNDLE_CONFIG: BundleConfig = {
    bundleType: 'topics',
    functionName: 'createtopicbundle',
    namedQuery: NAMED_QUERIES.TOPICS,
    cacheKeyPrefix: 'topic',
    displayName: 'topics',
    metadataDocPath: BUNDLE_METADATA_PATHS.TOPICS
};

export const SUBTITLE_BUNDLE_CONFIG: BundleConfig = {
    bundleType: 'subtitles',
    functionName: 'createsubtitlebundle',
    namedQuery: NAMED_QUERIES.SUBTITLES,
    cacheKeyPrefix: 'subtitle',
    displayName: 'subtitles',
    metadataDocPath: BUNDLE_METADATA_PATHS.SUBTITLES
};

export const BIBLE_CHAPTER_BUNDLE_CONFIG: BundleConfig = {
    bundleType: 'bible-chapters',
    functionName: 'createbiblechapterbundle',
    namedQuery: NAMED_QUERIES.BIBLE_CHAPTERS,
    cacheKeyPrefix: 'bible-chapter',
    displayName: 'bible chapters',
    metadataDocPath: BUNDLE_METADATA_PATHS.BIBLE_CHAPTERS
};

export const SUNDAY_HOMILY_BUNDLE_CONFIG: BundleConfig = {
    bundleType: 'sunday-homilies',
    functionName: 'createsundayhomilybundle',
    namedQuery: NAMED_QUERIES.SUNDAY_HOMILIES,
    cacheKeyPrefix: 'sunday-homily',
    displayName: 'sunday homilies',
    metadataDocPath: BUNDLE_METADATA_PATHS.SUNDAY_HOMILIES
}; 