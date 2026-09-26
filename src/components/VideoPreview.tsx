import { useEffect, useRef } from "react";

interface VideoPreviewProps {
  /** convertFileSrc 转出的 asset 协议地址。 */
  src: string;
  /** 播放引擎（主时钟）的当前位置，源时间轴。 */
  position: number;
  isPlaying: boolean;
  /** 与音频同一档变速：两边速度不同的话会一直互相追，画面反复卡顿。 */
  playbackRate: number;
}

/**
 * 与音频时间轴同步的视频画面预览。
 * `<video>` 静音播放（声音由播放引擎的媒体元素输出），播放 / 暂停 / seek /
 * 跳过切除区间全部以播放引擎为准：位置偏差超过容差或播放态变化时强制对齐。
 */
export default function VideoPreview({
  src,
  position,
  isPlaying,
  playbackRate,
}: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.playbackRate !== playbackRate) {
      video.playbackRate = playbackRate;
    }
    // 容差内的自然漂移不打扰，超差（seek / 跳切除区间 / 暂停后恢复）才强制对齐
    if (
      Number.isFinite(position) &&
      Math.abs(video.currentTime - position) > 0.2
    ) {
      video.currentTime = position;
    }
    if (isPlaying && video.paused && !video.ended) {
      void video.play().catch(() => undefined);
    } else if (!isPlaying && !video.paused) {
      video.pause();
    }
  }, [position, isPlaying, playbackRate]);

  return (
    <div className="video-preview">
      <video ref={videoRef} src={src} muted playsInline preload="auto" />
    </div>
  );
}
