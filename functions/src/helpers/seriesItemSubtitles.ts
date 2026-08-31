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
      // Subsplash legitimately leaves draft and scheduled series members
      // unpositioned. Their subtitle can be synchronized after publishing gives
      // them a position; they must not abort updates for positioned members.
      return [];
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
  const unpositionedItemCount = items.filter(
    (item) => !Number.isInteger(item.position) || (item.position ?? 0) < 1
  ).length;

  await runWithConcurrency(updates, maxConcurrency, async (update) => {
    await patchMediaItemSeries(update.id, seriesId, token, { subtitle: update.subtitle });
  });

  if (unpositionedItemCount > 0) {
    logger.warn('Deferred Subsplash series item subtitle synchronization until positions are available', {
      seriesId,
      unpositionedItemCount,
    });
  }

  logger.log('Synchronized Subsplash series item subtitles', {
    seriesId,
    seriesTitle: seriesTitle.trim(),
    inspected: items.length,
    updated: updates.length,
  });

  return { inspected: items.length, updated: updates.length };
}
