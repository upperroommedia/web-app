import { ImageSizes, type ImageType } from '../types/Image';
import type { Sermon } from '../types/SermonTypes';

type CanonicalImageRead = (id: string) => Promise<{ id: string; data: unknown } | undefined>;
const sizes: readonly ImageType['size'][] = ['thumbnail', 'small', 'medium', 'large', 'original', 'cropped'];

function canonicalImage(id: string, value: unknown): ImageType | undefined {
  if (!value || typeof value !== 'object') return;
  const image = value as Partial<ImageType>;
  if (
    !ImageSizes.includes(image.type!) ||
    !sizes.includes(image.size!) ||
    typeof image.name !== 'string' ||
    typeof image.downloadLink !== 'string' ||
    !image.downloadLink.trim() ||
    typeof image.width !== 'number' ||
    !Number.isFinite(image.width) ||
    image.width <= 0 ||
    typeof image.height !== 'number' ||
    !Number.isFinite(image.height) ||
    image.height <= 0 ||
    typeof image.dateAddedMillis !== 'number' ||
    !Number.isFinite(image.dateAddedMillis)
  )
    return;
  return { ...image, id } as ImageType;
}

/** At most three deduplicated document reads, only for currently empty aspect slots. */
export async function loadSpeakerImageDefaults(
  embedded: readonly ImageType[],
  current: readonly ImageType[],
  readImage: CanonicalImageRead
): Promise<{ images: ImageType[]; unavailable: boolean }> {
  const candidates = ImageSizes.filter((type) => !current.some((image) => image.type === type))
    .map((type) => ({ type, image: embedded.find((image) => image.type === type) }))
    .filter((candidate) => candidate.image !== undefined);
  const ids = [
    ...new Set(
      candidates
        .map(({ image }) => image!.id)
        .filter((id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 200 && !id.includes('/'))
    ),
  ];
  // Attach rejection handling to every read immediately; one failed optional
  // default does not discard another available canonical image.
  const resolved = new Map(
    await Promise.all(
      ids.map(async (id) => {
        try {
          const document = await readImage(id);
          return [id, document?.id === id ? canonicalImage(document.id, document.data) : undefined] as const;
        } catch {
          return [id, undefined] as const;
        }
      })
    )
  );
  const images: ImageType[] = [];
  let unavailable = false;
  for (const { type, image } of candidates) {
    const canonical = resolved.get(image!.id);
    if (!canonical || canonical.type !== type) unavailable = true;
    else images.push(canonical);
  }
  return { images, unavailable };
}

/** Never replace a newer speaker selection or any intervening manual image choice. */
export function applySpeakerImageDefaults(
  sermon: Sermon,
  images: ImageType[],
  context: {
    speakerId: string;
    imagesAtSelection: ImageType[];
    selection: number;
    currentSelection: number;
    mounted: boolean;
  }
): Sermon {
  if (
    !context.mounted ||
    context.selection !== context.currentSelection ||
    sermon.speakers.length !== 1 ||
    sermon.speakers[0].id !== context.speakerId ||
    sermon.images !== context.imagesAtSelection ||
    images.length === 0
  )
    return sermon;
  const missing = images.filter((image) => !sermon.images.some((current) => current.type === image.type));
  return missing.length ? { ...sermon, images: [...sermon.images, ...missing] } : sermon;
}
