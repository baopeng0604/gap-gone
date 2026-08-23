# Gap Gone 领域词汇

## AudioAsset

可被播放、编辑或导出的音频内容。原始录音和降噪后的版本都是独立的 AudioAsset，原始版本始终保留。

## RecordingTake

一次录音的生命周期。它从 3 秒准备倒计时开始，倒计时期间不采集音频；随后进入录音中和录音预览，最后被确认并转化为可编辑的 AudioAsset，或被取消并丢弃。

## TimeRange

音频时间轴上的半开区间 `[start, end)`。`start` 不得小于零，`end` 不得大于音频时长，且 `start < end`。

## EditTimeline

当前 AudioAsset 上需要跳过的 TimeRange 集合。区间按时间排序、互不重叠；它描述编辑结果，不改变原始 AudioAsset。内部区分手动切除区间与自动静音检测区间，最终播放和导出前再合并。

## SilenceDetectionCandidate

由静音分析生成、尚未应用到 EditTimeline 的候选 TimeRange 集合。候选区间只显示预览，不影响播放或导出；用户点击应用后才成为自动检测区间。

## PlaybackSession

一次连续的播放过程。它负责把编辑时间轴映射到原始音频时间，并在播放过程中跳过 EditTimeline 中的区间。

## MonitorLevel

录音输入的实时反馈，包括 RMS、Peak、峰值保持和数字削波状态。电平使用 dBFS 表示，-6 dBFS 以上属于预警，数字削波提示可单独清除。MonitorLevel 只描述测量结果，不代表是否把输入声音回放到输出设备。

## NoiseReductionVersion

基于某个 AudioAsset 生成的独立降噪版本，包含模型版本、强度预设和处理区间。降噪失败时，原始 AudioAsset 不受影响。

## 领域边界

- 取消 RecordingTake 不会进入编辑页，也不会留下临时音频。
- 打开或确认新的 AudioAsset 会清空上一份 AudioAsset 的 EditTimeline。
- 静音检测必须先生成 SilenceDetectionCandidate，应用前不能改变播放或导出结果。
- 恢复最近一次自动检测只移除自动检测区间，不能覆盖手动切除区间。
- “去静音/跳过”会缩短播放和导出后的时长；它不等同于保留时长的静音效果。
- 设备权限拒绝、设备拔出和设备占用都是可恢复的录音错误。
- 全部时间轴被跳过时，产品必须显示明确的空结果，而不是创建一个无效的零长度音频。
- 降噪是可撤销的派生操作，不覆盖原始录音。
