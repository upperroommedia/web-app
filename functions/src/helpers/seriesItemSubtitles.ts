import { logger } from 'firebase-functions/v2';
import { patchMediaItemSeries } from './seriesHelpers';
import { runWithConcurrency } from '../utils/runWithConcurrency';

export interface SeriesItemSubtitleSource {
  id: string;
  position: number | null;
  subtitle?: string | null;
}

export interface SeriesItemSubtitleUpdate {
  id: string;
  position: number;
  subtitle: string;
}

export function formatSeriesItemSubtitle(seriesTitle: string, position: number): string {
  const normalizedTitle = seriesTitle.trim();
  if (!normalizedTitle) {
    throw new Error('A series title is required to format a series item subtitle.');
  }
  if (!Number.isInteger(position) || position < 1) {
    throw new Error('A series item position must be a positive integer.');
  }

  return `Part ${position} of ${normalizedTitle}`;
}

export function planSeriesItemSubtitleUpdates(
  seriesTitle: string,
  items: SeriesItemSubtitleSource[]
): SeriesItemSubtitleUpdate[] {
  return items.flatMap((item) => {
    if (!Number.isInteger(item.position) || (item.position ?? 0) < 1) {
      throw new Error(`Series media item ${item.id} does not have a usable positive position.`);
    }

    const position = item.position as number;
    const subtitle = formatSeriesItemSubtitle(seriesTitle, position);
    return item.subtitle === subtitle ? [] : [{ id: item.id, position, subtitle }];
  });
}

export interface SyncSeriesItemSubtitlesResult {
  inspected: number;
  updated: number;
}

export async function syncSeriesItemSubtitles(
  seriesId: string,
  seriesTitle: string,
  items: SeriesItemSubtitleSource[],
  token: string,
  options?: { maxConcurrency?: number }
): Promise<SyncSeriesItemSubtitlesResult> {
  const updates = planSeriesItemSubtitleUpdates(seriesTitle, items);
  const maxConcurrency = Math.max(1, Math.min(options?.maxConcurrency ?? 4, 5));

  await runWithConcurrency(updates, maxConcurrency, async (update) => {
    await patchMediaItemSeries(update.id, seriesId, token, { subtitle: update.subtitle });
  });

  logger.log('Synchronized Subsplash series item subtitles', {
    seriesId,
    seriesTitle: seriesTitle.trim(),
    inspected: items.length,
    updated: updates.length,
  });

  return { inspected: items.length, updated: updates.length };
}
