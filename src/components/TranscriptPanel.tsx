import { useEffect, useRef } from "react";
import type { Region } from "../utils/regionUtils";
import { exportTranscript, type TranscriptSegment } from "../utils/transcribe";

interface TranscriptPanelProps {
  segments: TranscriptSegment[];
  currentTime: number;
  deletedRegions: Region[];
  onSeek: (time: number) => void;
  onClose: () => void;
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/** 句子中点落在切除区间内 → 划线置灰（原始时间轴锚定，不重跑）。 */
function isDeleted(segment: TranscriptSegment, regions: Region[]): boolean {
  const mid = (segment.start + segment.end) / 2;
  return regions.some((region) => mid >= region.start && mid < region.end);
}

export default function TranscriptPanel({
  segments,
  currentTime,
  deletedRegions,
  onSeek,
  onClose,
}: TranscriptPanelProps) {
  const activeIndex = segments.findIndex(
    (segment) => currentTime >= segment.start && currentTime < segment.end,
  );
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // 播放句高亮跟随滚动；用户手动滚动离开时不强行拉回（nearest 不打扰）。
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <section className="transcript-panel" aria-label="转录文字">
      <header className="transcript-header">
        <span className="transcript-title">转录文字（{segments.length} 句）</span>
        <span className="transcript-actions">
          <button onClick={() => void exportTranscript(segments, "srt")}>
            导出 SRT
          </button>
          <button onClick={() => void exportTranscript(segments, "txt")}>
            导出 TXT
          </button>
          <button onClick={onClose}>关闭</button>
        </span>
      </header>
      <div className="transcript-list">
        {segments.map((segment, index) => (
          <button
            key={index}
            ref={index === activeIndex ? activeRef : null}
            className={[
              "transcript-segment",
              index === activeIndex ? "transcript-active" : "",
              isDeleted(segment, deletedRegions) ? "transcript-deleted" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => onSeek(segment.start)}
            title="点击跳转到该句"
          >
            <span className="transcript-time">{formatClock(segment.start)}</span>
            <span className="transcript-text">{segment.text}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
