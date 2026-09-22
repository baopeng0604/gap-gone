/**
 * 左侧固定栏：从头播放 + 循环开关 + 竖向播放速度滑条 + 倍速读数。
 *
 * 工具栏已经排满，这几个"边听边调"的控件单独成栏。
 * 速度低于 1.0 用冷色、高于 1.0 用暖色，1.0 保持中性灰。
 */

/** 速度档位（倍速）。滑条按索引吸附，避开小数步进的浮点误差。 */
export const SPEED_STEPS = [0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0];

interface PlaybackSidebarProps {
  /** 当前倍速，取值来自 SPEED_STEPS。 */
  speed: number;
  onSpeedChange: (speed: number) => void;
  /** 点击读数复位到 1.0 倍速。 */
  onSpeedReset: () => void;
  /** 从成片开头开始播放（已在播放中则重新开始）。 */
  onPlayFromStart: () => void;
  looping: boolean;
  onToggleLoop: () => void;
  /** 无音频或处理中：控件置灰。 */
  disabled: boolean;
}

export default function PlaybackSidebar({
  speed,
  onSpeedChange,
  onSpeedReset,
  onPlayFromStart,
  looping,
  onToggleLoop,
  disabled,
}: PlaybackSidebarProps) {
  const index = Math.max(0, SPEED_STEPS.indexOf(speed));
  const tone = speed < 1 ? "slow" : speed > 1 ? "fast" : "normal";
  const lastIndex = SPEED_STEPS.length - 1;

  return (
    <aside className="playback-sidebar" aria-label="播放速度与循环">
      <button
        type="button"
        className="playback-start"
        onClick={onPlayFromStart}
        disabled={disabled}
        title="从头播放（成片开头，已切除的区间跳过）"
      >
        <span aria-hidden="true">⇤</span>
      </button>
      <button
        type="button"
        className={looping ? "playback-loop is-on" : "playback-loop"}
        onClick={onToggleLoop}
        disabled={disabled}
        aria-pressed={looping}
        title={
          looping
            ? "循环播放中（整段成片），点击关闭并停止播放（快捷键 L）"
            : "循环播放整段成片：点亮即从成片开头开始播（快捷键 L）"
        }
      >
        <span aria-hidden="true">↻</span>
      </button>
      <div className="playback-speed-wrap">
        <input
          type="range"
          className={`playback-speed tone-${tone}`}
          min={0}
          max={lastIndex}
          step={1}
          value={index}
          onChange={(event) =>
            onSpeedChange(SPEED_STEPS[Number(event.target.value)])
          }
          disabled={disabled}
          aria-label="播放速度"
          aria-valuetext={`${speed.toFixed(1)} 倍速`}
          title="上下拖动调整播放速度，[ / ] 也可调节"
        />
        {/* 每个档位一个刻度点，按索引均分；0.6 在底部、2.0 在顶部 */}
        <div className="playback-ticks" aria-hidden="true">
          {SPEED_STEPS.map((step, tickIndex) => (
            <span
              key={step}
              className="playback-tick"
              style={{ bottom: `${(tickIndex / lastIndex) * 100}%` }}
            />
          ))}
        </div>
      </div>
      <button
        type="button"
        className={`playback-readout tone-${tone}`}
        onClick={onSpeedReset}
        disabled={disabled}
        title="点击复位到 1.0 倍速"
      >
        {speed.toFixed(1)}×
      </button>
    </aside>
  );
}
