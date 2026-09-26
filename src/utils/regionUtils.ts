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

/**
 * 把源时间轴上的区间映射到成片时间轴（跳过删除区间后的累计时间）。
 * 区间横跨删除段时会被切成多段；整段落在删除区间内返回空数组。
 * 用途：转录时间码在源时间轴上，导出视频的字幕必须换算到成片时间轴。
 *
 * `keptOverride` 用于**无损快速档**：那一档会把每段起点吸附到关键帧上（成片比「精确
 * 删除」多留一小截），成片时间轴必须以吸附后的区间为基准，否则字幕会随每个吸附点累积错位。
 *
 * `transitions` 用于**精确编码档的切片过渡**：每个接缝 t 秒是从相邻两段的边界各取 t
 * 混合而成（重叠式过渡），所以每段在成片里只剩「主体」、且成片整体比硬切短 Σt。
 * 不传（或传全 0）时行为与硬切完全一致。
 */
export function mapRangeToKept(
  range: Region,
  deletedRegions: Region[],
  duration: number,
  keptOverride?: Region[],
  transitions?: number[],
): Region[] {
  const kept = keptOverride ?? getKeptRegions(deletedRegions, duration);
  const result: Region[] = [];
  let offset = 0;
  for (let index = 0; index < kept.length; index += 1) {
    const region = kept[index];
    // 本段头部被上一个接缝取走 t_{i-1}、尾部被本接缝取走 t_i，只剩中间的「主体」
    const headTrim = index > 0 ? transitions?.[index - 1] ?? 0 : 0;
    const tailTrim = index < kept.length - 1 ? transitions?.[index] ?? 0 : 0;
    const bodyStart = region.start + headTrim;
    const bodyEnd = Math.max(bodyStart, region.end - tailTrim);
    const start = Math.max(bodyStart, range.start);
    const end = Math.min(bodyEnd, range.end);
    if (end > start) {
      // 字幕伸进被裁掉的那两截时，映射结果也要跟着扩到过渡段上：那部分内容是在
      // 过渡里播出去的，字幕盖住它才不会在过渡时闪一下。
      const extendedStart = range.start < bodyStart ? start - headTrim : start;
      const extendedEnd = range.end > bodyEnd ? end + tailTrim : end;
      const piece = {
        start: offset + (extendedStart - bodyStart),
        end: offset + (extendedEnd - bodyStart),
      };
      // 横跨接缝的字幕会被切成两段，中间隔着 t 秒的过渡段 —— 那是同一句话，
      // 合并起来让它盖住过渡，而不是在过渡时闪一下。
      const previous = result[result.length - 1];
      if (previous && piece.start - previous.end <= tailTrim + 0.001) {
        previous.end = piece.end;
      } else {
        result.push(piece);
      }
    }
    // 主体 + 紧随其后的过渡段都占据成片时间轴
    offset += bodyEnd - bodyStart + tailTrim;
  }
  return result;
}
