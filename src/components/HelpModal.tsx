interface HelpModalProps {
  open: boolean;
  onClose: () => void;
  editMode: "seek" | "select" | "cut" | "restore";
}

const modeHints = {
  seek: "当前模式：浏览。左键点击波形可跳转；播放中点击会继续播放。",
  select: "当前模式：选择。拖拽波形建立选区，供局部降噪使用。",
  cut: "当前模式：切除。拖拽波形标记需要跳过的区间。",
  restore: "当前模式：恢复。拖拽已标记区间可恢复原始音频。",
};

export default function HelpModal({
  open,
  onClose,
  editMode,
}: HelpModalProps) {
  if (!open) return null;

  return (
    <div className="help-modal-overlay" onClick={onClose}>
      <div
        className="help-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-modal-header">
          <h2 id="help-modal-title" className="help-modal-title">
            使用帮助
          </h2>
          <button className="help-modal-close" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="help-modal-body">
          <p className="help-context-note">{modeHints[editMode]}</p>
          <h3>快速上手</h3>
          <ul>
            <li>
              在文件/录音组中点击<span className="help-modal-kbd">打开</span>
              导入音频，也可以按<span className="help-modal-kbd">O</span>；
              点击<span className="help-modal-kbd">录音设置</span>选择麦克风后点击
              <span className="help-modal-kbd">录音</span>或按
              <span className="help-modal-kbd">R</span>
            </li>
            <li>
              点击录音后会先倒计时 3 秒；倒计时中可以点击
              <span className="help-modal-kbd">取消</span>，结束后才开始录音
            </li>
            <li>
              录音停止后，点击<span className="help-modal-kbd">取消</span>丢弃，
              或点击<span className="help-modal-kbd">确定并编辑</span>（也可按
              <span className="help-modal-kbd">Enter</span>）进入波形页面
            </li>
            <li>
              选择去静音预设后点击<span className="help-modal-kbd">检测静音</span>，
              检查候选区间，再点击<span className="help-modal-kbd">应用检测</span>
            </li>
            <li>
              编辑完成后使用<span className="help-modal-kbd">撤销/重做</span>修正，
              最后点击<span className="help-modal-kbd">导出 WAV</span>保存结果
            </li>
          </ul>

          <h3>文件和录音</h3>
          <ul>
            <li>
              <span className="help-modal-kbd">打开</span>：导入 MP3、WAV、M4A
              等浏览器可解析的音频
            </li>
            <li>
              <span className="help-modal-kbd">录音设置</span>：选择输入设备、
              刷新设备列表并查看录音格式
            </li>
            <li>
              <span className="help-modal-kbd">录音</span>：请求麦克风权限并开始
              3 秒倒计时；倒计时结束后开始 48 kHz 单声道录音。录音中按
              <span className="help-modal-kbd">P</span>暂停/继续、
              <span className="help-modal-kbd">S</span>停止，或按
              <span className="help-modal-kbd">Esc</span>取消并返回编辑页
            </li>
          </ul>

          <h3>播放</h3>
          <ul>
            <li>
              <span className="help-modal-kbd">播放/暂停</span>或
              <span className="help-modal-kbd">Space</span>：反复切换播放和暂停
            </li>
            <li>
              播放中点击任意波形位置会跳转并继续播放；暂停时点击只移动播放头
            </li>
            <li>播放会自动跳过已标记的区间，播放头仍显示原始时间轴位置</li>
          </ul>

          <h3>编辑</h3>
          <ul>
            <li>
              <span className="help-modal-kbd">选择</span>：拖拽建立选区，供降噪使用
            </li>
            <li>
              <span className="help-modal-kbd">切除</span>：左键拖拽标记跳过区间；
              <span className="help-modal-kbd">恢复</span>：左键拖拽取消标记
            </li>
            <li>
              <span className="help-modal-kbd">检测静音</span>：按当前预设分析，
              只显示候选区间，不会立即修改音频
            </li>
            <li>
              <span className="help-modal-kbd">应用检测</span>：确认候选后加入
              跳过区间；<span className="help-modal-kbd">清除候选</span>：放弃预览
            </li>
            <li>
              <span className="help-modal-kbd">紧凑/自然/宽松</span>：控制每个
              静音区间两端保留的声音，默认是自然
            </li>
            <li>
              <span className="help-modal-kbd">恢复本次检测</span>：只移除最近
              应用的自动检测结果，不影响手动切除
            </li>
            <li>
              <span className="help-modal-kbd">撤销</span>和
              <span className="help-modal-kbd">重做</span>：恢复或重放最近的编辑操作
            </li>
            <li>右键拖拽切除，中键拖拽恢复；左键单击仍可跳转播放</li>
          </ul>

          <h3>降噪</h3>
          <ul>
            <li>
              <span className="help-modal-kbd">降噪：轻/中/强</span>：选择
              DeepFilterNet3 的处理强度
            </li>
            <li>
              没有选区时处理整段音频；有选区时只处理选区。结果会先进入试听状态
            </li>
            <li>
              <span className="help-modal-kbd">确认降噪</span>：保留试听版本；
              <span className="help-modal-kbd">取消试听</span>：恢复处理前版本
            </li>
            <li>
              <span className="help-modal-kbd">恢复原始</span>：撤回已确认的降噪版本
            </li>
          </ul>

          <h3>录音电平</h3>
          <ul>
            <li>RMS 是平均响度，Peak 是瞬时峰值，单位都是 dBFS。</li>
            <li>峰值保持显示录音期间出现过的最高峰值。</li>
            <li>电平条按 dBFS 标出 -24、-18、-12、-6 和 -3 dB 刻度，越接近右侧越容易过载。</li>
            <li>-6 dBFS 以上为黄色预警；最右侧 CLIP 红标亮起表示检测到削波。</li>
            <li>红标会保持亮起，点击红标即可清除提示，不会修改录音。</li>
            <li>耳机监听默认关闭；开启时请不要使用扬声器，以免产生啸叫。</li>
          </ul>

          <h3>快捷键</h3>
          <ul>
            <li><span className="help-modal-kbd">Space</span>：播放 / 暂停</li>
            <li>
              <span className="help-modal-kbd">D</span>：检测静音（只生成候选预览）
            </li>
            <li>
              <span className="help-modal-kbd">R</span>：空闲时开始录音
            </li>
            <li>
              <span className="help-modal-kbd">Shift+R</span>：恢复最近一次应用的自动检测
            </li>
            <li>
              <span className="help-modal-kbd">P</span>：暂停 / 继续录音
            </li>
            <li>
              <span className="help-modal-kbd">S</span>：停止录音
            </li>
            <li>
              <span className="help-modal-kbd">⌘/Ctrl+Z</span>：撤销；
              <span className="help-modal-kbd">⌘/Ctrl+Shift+Z</span>：重做
            </li>
            <li>
              <span className="help-modal-kbd">⌘/Ctrl+S</span>：导出 WAV
            </li>
            <li>
              <span className="help-modal-kbd">O</span>：打开音频文件
            </li>
            <li>
              <span className="help-modal-kbd">Enter</span>：录音结束后确定并编辑
            </li>
            <li>
              <span className="help-modal-kbd">Esc</span>：取消倒计时、录音中取消并返回编辑页，或取消录音结果
            </li>
            <li>
              <span className="help-modal-kbd">H</span> 或{" "}
              <span className="help-modal-kbd">?</span>：打开帮助
            </li>
            <li>帮助打开时按 <span className="help-modal-kbd">Esc</span>：关闭帮助</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

