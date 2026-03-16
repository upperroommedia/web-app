const parsePositiveInteger = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
};

// export const DEFAULT_MAX_LIST_SIZE = 200;
export const DEFAULT_MAX_LIST_SIZE = 3; // TODO: Remove this override after testing with smaller list sizes

export const getConfiguredMaxListSize = (): number =>
  parsePositiveInteger(process.env.SUBSPLASH_DEV_MAX_LIST_SIZE) ?? DEFAULT_MAX_LIST_SIZE;

export const getPageContentCapacity = (
  remainingContentCount: number,
  maxListSize: number = getConfiguredMaxListSize()
): number => (remainingContentCount > maxListSize ? Math.max(0, maxListSize - 1) : maxListSize);
