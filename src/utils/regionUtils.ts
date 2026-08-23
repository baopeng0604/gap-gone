export interface Region {
  start: number;
  end: number;
}

export function clampRegion(region: Region, duration: number): Region | null {
  const start = Math.max(0, Math.min(duration, region.start));
  const end = Math.max(0, Math.min(duration, region.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return { start, end };
}

export function normalizeRegions(
  regions: Region[],
  duration?: number,
): Region[] {
  const valid = regions
    .map((region) =>
      duration === undefined ? region : clampRegion(region, duration),
    )
    .filter((region): region is Region => region !== null)
    .map((region) => ({ start: region.start, end: region.end }))
    .sort((a, b) => a.start - b.start);

  return valid.reduce<Region[]>((merged, current) => {
    const previous = merged[merged.length - 1];
    if (previous && current.start <= previous.end) {
      return [
        ...merged.slice(0, -1),
        { start: previous.start, end: Math.max(previous.end, current.end) },
      ];
    }
    return [...merged, current];
  }, []);
}

export function mergeRegions(
  regions: Region[],
  newRegion: Region,
  duration?: number,
): Region[] {
  return normalizeRegions([...regions, newRegion], duration);
}

export function subtractRegion(
  regions: Region[],
  subtract: Region,
  duration?: number,
): Region[] {
  const target = duration === undefined ? subtract : clampRegion(subtract, duration);
  if (!target) return normalizeRegions(regions, duration);

  return normalizeRegions(
    regions.flatMap((region) => {
      if (target.end <= region.start || target.start >= region.end) {
        return [{ start: region.start, end: region.end }];
      }

      const left = region.start < target.start
        ? [{ start: region.start, end: target.start }]
        : [];
      const right = region.end > target.end
        ? [{ start: target.end, end: region.end }]
        : [];
      return [...left, ...right];
    }),
    duration,
  );
}

export function getKeptRegions(
  deletedRegions: Region[],
  duration: number,
): Region[] {
  const deleted = normalizeRegions(deletedRegions, duration);
  const kept: Region[] = [];
  let cursor = 0;

  for (const region of deleted) {
    if (cursor < region.start) {
      kept.push({ start: cursor, end: region.start });
    }
    cursor = Math.max(cursor, region.end);
  }

  if (cursor < duration) {
    kept.push({ start: cursor, end: duration });
  }
  return kept;
}

export function getPlayableDuration(
  deletedRegions: Region[],
  duration: number,
): number {
  return getKeptRegions(deletedRegions, duration).reduce(
    (total, region) => total + region.end - region.start,
    0,
  );
}

export function nextPlayableTime(
  time: number,
  deletedRegions: Region[],
  duration: number,
): number {
  const normalizedTime = Math.max(0, Math.min(duration, time));
  const deleted = normalizeRegions(deletedRegions, duration);
  const containing = deleted.find(
    (region) => normalizedTime >= region.start && normalizedTime < region.end,
  );
  return containing ? containing.end : normalizedTime;
}
