import WaveformRow from "./WaveformRow";
import type { TranscriptWord } from "../utils/transcribe";

interface WaveformScoreProps {
  buffer: AudioBuffer;
  currentTime: number;
  onSeek: (time: number) => void;
  secondsPerRow?: number;
  regions: { start: number; end: number }[];
  onRegionAdd: (start: number, end: number) => void;
  onRegionRemove: (start: number, end: number) => void;
  editMode?: "seek" | "select" | "cut" | "restore";
  selection?: { start: number; end: number } | null;
  onSelectionChange?: (selection: { start: number; end: number } | null) => void;
  previewRegions?: { start: number; end: number }[];
  /** 字词级转录，贴在每行波形下方的词带。 */
  words?: TranscriptWord[] | null;
}

const WaveformScore = ({
  buffer,
  currentTime,
  onSeek,
  secondsPerRow = 10,
  regions,
  onRegionAdd,
  onRegionRemove,
  editMode = "seek",
  selection = null,
  onSelectionChange,
  previewRegions = [],
  words = null,
}: WaveformScoreProps) => {
  const duration = buffer.duration;
  const rowCount = Math.ceil(duration / secondsPerRow);
  const rows = [];

  for (let i = 0; i < rowCount; i++) {
    const startTime = i * secondsPerRow;
    const endTime = Math.min((i + 1) * secondsPerRow, duration);
    const rowWords = words
      ? words.filter((word) => word.start < endTime && word.end > startTime)
      : null;

    rows.push(
      <WaveformRow
        key={i}
        buffer={buffer}
        startTime={startTime}
        endTime={endTime}
        currentTime={currentTime}
        onSeek={onSeek}
        regions={regions}
        onRegionAdd={onRegionAdd}
        onRegionRemove={onRegionRemove}
        editMode={editMode}
        selection={selection}
        onSelectionChange={onSelectionChange}
        previewRegions={previewRegions}
        words={rowWords}
      />,
    );
  }

  return <div className="waveform-score-container">{rows}</div>;
};

export default WaveformScore;
