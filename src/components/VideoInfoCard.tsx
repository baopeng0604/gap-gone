/**
 * 视频预览右侧的信息卡（0.1.78）。
 *
 * 上半是**动态**的「本次导出会怎样」：走「无损快切」还是降级为「精确重编码」、
 * 为什么、以及这条链上的关键事实（关键帧间隔、切点吸附代价、音轨去向、字幕）。
 * 这套判定本来只在点导出那一刻用 toast 蹦一句，看完就没了 —— 而它恰恰是每次导出前
 * 都要判断一次的东西（判定口径见 AGENTS.md 硬约束 19）。
 * 下半是**静态**的素材参数，让人一眼确认「这份素材到底是什么」。
 *
 * 语气是刻意中性的：快速档不可用往往是素材本身的属性决定的（HEVC / 含 B 帧 /
 * 带旋转），不是用户做错了什么，所以不用黄红警示色；只有在「动手就能改善」时才
 * 多给一句建议（目前只有关键帧间隔，见调用方算好的 `advice`）。
 */

interface VideoInfoCardProps {
  /** 卡片计算宽度（px）。可用空间不足时父组件直接不渲染，所以这里恒 > 0。 */
  width: number;
  /** 素材参数（VideoAsset 的子集，结构化传入，避免跨文件导出类型）。 */
  asset: {
    width: number;
    height: number;
    duration: number;
    /** 帧率原始分数串（"30/1"、"30000/1001"）。 */
    fps: string;
    videoCodec: string;
    audioCodec: string;
    sampleRate: number;
    channels: number;
    /** 文件大小（字节，0 = 读不到）。 */
    size: number;
  };
  /** 本次导出的判定结果（全部由调用方算好）。 */
  plan: {
    variant: "fastcopy" | "reencode";
    /** 为什么没走无损快切；null = 走的就是无损快切，或用户本来就选了精确编码。 */
    fallbackReason: string | null;
    /** 可改善时的建议（如关键帧间隔过长）；null = 没什么可建议的。 */
    advice: string | null;
    /** 关键帧间隔（秒，0 = 未知）。 */
    keyframeInterval: number;
    /** 切点吸附的代价：最多少删多少秒静音（0 = 没有代价）。 */
    maxShift: number;
    /** 音轨是否被处理过（降噪 / 压缩 / 响度归一化）→ 导出要回写处理后音轨。 */
    audioProcessed: boolean;
    /** 是否勾了「字幕 SRT」。 */
    exportSubtitles: boolean;
  };
}

function formatFps(raw: string): string {
  const [numerator, denominator] = raw.split("/").map(Number);
  if (!Number.isFinite(numerator)) return raw;
  const value = denominator ? numerator / denominator : numerator;
  return `${Number.isInteger(value) ? value : value.toFixed(2)} fps`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function formatChannels(channels: number): string {
  if (channels === 1) return "单声道";
  if (channels === 2) return "立体声";
  return channels > 0 ? `${channels} 声道` : "—";
}

export default function VideoInfoCard({
  width,
  asset,
  plan,
}: VideoInfoCardProps) {
  // 参数表两列能放下就两列，放不下（卡片被压到 480px 以下）就退成一列
  const twoColumn = width >= 480;
  const fastcopy = plan.variant === "fastcopy";

  const facts: Array<[string, string]> = [
    [
      "关键帧间隔",
      plan.keyframeInterval > 0
        ? `${plan.keyframeInterval.toFixed(1)} 秒`
        : "未知",
    ],
    ["音轨", plan.audioProcessed ? "回写处理后音轨" : "原样拷贝"],
    ["字幕", plan.exportSubtitles ? "会写出 .srt" : "不导出"],
  ];
  if (fastcopy && plan.maxShift > 0.02) {
    facts.splice(1, 0, ["切点吸附", `最多少删 ${plan.maxShift.toFixed(1)} 秒静音`]);
  }

  const params: Array<[string, string]> = [
    ["分辨率", `${asset.width}×${asset.height}`],
    ["帧率", formatFps(asset.fps)],
    ["时长", formatDuration(asset.duration)],
    ["视频编码", asset.videoCodec.toUpperCase()],
    [
      "音轨",
      `${asset.audioCodec.toUpperCase()} ${(asset.sampleRate / 1000).toFixed(1)} kHz ${formatChannels(asset.channels)}`,
    ],
    ["文件大小", formatSize(asset.size)],
  ];

  return (
    <aside className="video-meta" style={{ width }} aria-label="视频与本次导出信息">
      <div className="video-meta-verdict">
        <span className="video-meta-label">本次导出</span>
        <strong>{fastcopy ? "无损快切" : "精确重编码"}</strong>
        {plan.fallbackReason && <p>{plan.fallbackReason}</p>}
        {!fastcopy && !plan.fallbackReason && (
          <p>按你的档位设置重编码画面：比无损慢，画面有一次有损</p>
        )}
        {plan.advice && <p className="video-meta-advice">{plan.advice}</p>}
      </div>

      <div className="video-meta-facts">
        {facts.map(([label, value]) => (
          <div className="video-meta-row" key={label}>
            <span className="video-meta-key">{label}</span>
            <span className="video-meta-value">{value}</span>
          </div>
        ))}
      </div>

      <div
        className={`video-meta-params${twoColumn ? "" : " video-meta-params-single"}`}
      >
        {params.map(([label, value]) => (
          <div className="video-meta-row" key={label}>
            <span className="video-meta-key">{label}</span>
            <span className="video-meta-value">{value}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
