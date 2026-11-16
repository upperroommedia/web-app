export const MAX_SUBSPLASH_TOPICS = 10;
export const MAX_SUBSPLASH_SPEAKERS = 3;

export const getSubsplashTagValidationError = (data: { topics?: unknown; speakers?: unknown }): string | null => {
  if (data.topics !== undefined) {
    if (!Array.isArray(data.topics) || data.topics.some((topic) => typeof topic !== 'string' || !topic.trim())) {
      return 'Topics must be an array of non-empty names.';
    }
    if (data.topics.length > MAX_SUBSPLASH_TOPICS) {
      return `Select at most ${MAX_SUBSPLASH_TOPICS} topics before publishing to Subsplash.`;
    }
  }
  if (data.speakers !== undefined) {
    if (
      !Array.isArray(data.speakers) ||
      data.speakers.some((speaker) => !speaker || typeof speaker.name !== 'string' || !speaker.name.trim())
    ) {
      return 'Speakers must be an array of speakers with non-empty names.';
    }
    if (data.speakers.length > MAX_SUBSPLASH_SPEAKERS) {
      return `Select at most ${MAX_SUBSPLASH_SPEAKERS} speakers before publishing to Subsplash.`;
    }
  }
  return null;
};
