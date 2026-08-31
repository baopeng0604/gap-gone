interface WaveSidebarProps {
  /** 播放中的实时电平；未播放时为 null，刻度回落到底。 */
  level: { rmsDb: number; peakDb: number } | null;
  /** 整段音频真实峰值，用来对照波形是否顶满（近 0 dBFS 才会削波）。 */
  filePeakDb: number | null;
}

const MIN_DB = -30;
const MARKS = [-24, -18, -12, -6, 0];

function meterPosition(db: number) {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - MIN_DB) / -MIN_DB));
}

function formatDb(value: number) {
  return Number.isFinite(value) ? value.toFixed(1) : "-∞";
}

/** 右侧固定栏：上半部播放实时音量竖排刻度图，底部「回到顶部」按钮。 */
export default function WaveSidebar({ level, filePeakDb }: WaveSidebarProps) {
  const live = Boolean(level);
  const rmsDb = level?.rmsDb ?? Number.NEGATIVE_INFINITY;
  const peakDb = live
    ? (level?.peakDb ?? Number.NEGATIVE_INFINITY)
    : (filePeakDb ?? Number.NEGATIVE_INFINITY);

  return (
    <aside className="wave-sidebar" aria-label="播放音量与波形导航">
      <div className="sidebar-meter" aria-label="实时播放电平">
        <span className="sidebar-meter-readout">
          {level
            ? `Pk ${formatDb(peakDb)}`
            : `文件 ${formatDb(filePeakDb ?? Number.NEGATIVE_INFINITY)}`}
        </span>
        <span className="sidebar-meter-readout sidebar-meter-readout-secondary">
          {level ? `RMS ${formatDb(rmsDb)}` : "dBFS"}
        </span>
        <div className="sidebar-meter-body">
          <div
            className={`sidebar-meter-track${peakDb >= -6 ? " sidebar-meter-warning" : ""}`}
          >
            <div
              className="sidebar-meter-fill"
              style={{ height: `${meterPosition(rmsDb) * 100}%` }}
            />
            <div
              className="sidebar-meter-peak"
              style={{ bottom: `calc(${meterPosition(peakDb) * 100}% - 1px)` }}
            />
            {MARKS.map((db) => (
              <span
                key={db}
                className="sidebar-meter-tick"
                style={{ bottom: `${meterPosition(db) * 100}%` }}
              />
            ))}
          </div>
          <div className="sidebar-meter-scale" aria-hidden="true">
            {MARKS.map((db) => (
              <span
                key={db}
                className="sidebar-meter-label"
                style={{ bottom: `${meterPosition(db) * 100}%` }}
              >
                {db}
              </span>
            ))}
          </div>
        </div>
      </div>
      <button
        type="button"
        className="sidebar-top-btn"
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        title="一键滚动回波形顶部"
      >
        <span aria-hidden="true">↑</span>
        回到顶部
      </button>
    </aside>
  );
}
