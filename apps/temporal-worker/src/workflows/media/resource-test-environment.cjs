// Fixture media is kilobytes; test capacity must not reserve production-sized scratch.
process.env.TEMPORAL_MEDIA_MAX_SOURCE_BYTES = String(4 * 1024 ** 2);
process.env.TEMPORAL_MEDIA_MAX_OUTPUT_BYTES = String(4 * 1024 ** 2);
process.env.TEMPORAL_MEDIA_WORKSPACE_MAX_BYTES = String(12 * 1024 ** 2);
process.env.TEMPORAL_MEDIA_DISK_HEADROOM_BYTES = String(1024 ** 3);
