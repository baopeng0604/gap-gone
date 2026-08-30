/**
 * 从转录文本提取导出文件名关键词（完全离线，零依赖）。
 *
 * Intl.Segmenter 是 WebView 引擎原生分词 API（WebView2/Chromium 87+、
 * WKWebView/Safari 14.1+），遵循 Unicode 分词标准，"zh" 模式下中英文
 * 都能按词切分。老系统不支持时返回 null，调用方回退日期命名。
 */

/** 口语高频虚词与功能词（中英混合），关键词提取时直接排除。 */
const STOPWORDS = new Set([
  // 中文代词/助词/副词/连词/量词/口语填充词
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "我们", "你们",
  "他们", "她们", "自己", "什么", "哪个", "哪些", "这个", "那个", "这些",
  "那些", "这里", "那里", "怎么", "为什么", "然后", "就是", "还是", "但是",
  "所以", "因为", "如果", "虽然", "而且", "或者", "以及", "没有", "不是",
  "一个", "一些", "一下", "一点", "这样", "那样", "可以", "应该", "可能",
  "已经", "还有", "会", "有", "在", "和", "跟", "对", "就", "也", "都",
  "还", "再", "又", "很", "挺", "比较", "非常", "特别", "真的", "时候",
  "东西", "事情", "问题", "意思", "感觉", "觉得", "知道", "觉得", "今天",
  "明天", "昨天", "现在", "开始", "的时候", "的话",
  // 英文功能词
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "because",
  "of", "to", "in", "on", "at", "for", "with", "about", "from", "by",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "can", "could", "should", "shall",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us",
  "them", "my", "your", "his", "its", "our", "their", "this", "that",
  "these", "those", "there", "here", "what", "which", "who", "when",
  "where", "why", "how", "all", "each", "every", "some", "any", "no",
  "not", "only", "very", "just", "also", "too", "now", "get", "got",
  "going", "gonna", "wanna", "yeah", "okay", "ok", "well", "like",
]);

/** 文件名非法字符（Windows 保留 \/:*?"<>| 以及控制符与空白）。 */
const ILLEGAL_FILENAME = /[\\/:*?"<>|\s]+/g;

// TS lib（ES2020）尚无 Intl.Segmenter 类型，运行时 WebView2/WKWebView 已支持。
// 此处声明用到的最小结构，能力检测失败则优雅回退。
interface SegmenterData {
  segment: string;
  isWordLike?: boolean;
}

interface SegmenterLike {
  segment(input: string): Iterable<SegmenterData>;
}

type SegmenterConstructor = new (
  locale?: string,
  options?: { granularity?: "grapheme" | "word" | "sentence" },
) => SegmenterLike;

function getSegmenterConstructor(): SegmenterConstructor | undefined {
  return (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
}

/** 纯中日韩表意文字（bigram 合并只对中文相邻词生效，英文复合词不拼）。 */
const CJK_ONLY = /^[\u4e00-\u9fff]+$/;

function isKeywordCandidate(word: string, maxLength: number): boolean {
  return (
    word.length >= 2 && word.length <= maxLength && !STOPWORDS.has(word)
  );
}

/**
 * 从转录句子里提取最高频的实义词作为文件名关键词。
 *
 * 算法：分词 → 单词频次 + 相邻二元词合并（ICU 会把「人工智能」切成
 * 「人工/智能」，成对出现的相邻中文词合并还原完整术语）→
 * 按（频次, 词长）取最优。
 *
 * @param segments 转录句子（只用 text 字段）
 * @param maxLength 关键词最大字符数（默认 7，即"小于 8 个字"）
 * @returns 关键词；无转录 / 不支持分词 / 无实义词时返回 null
 */
export function extractKeyword(
  segments: readonly { text: string }[],
  maxLength = 7,
): string | null {
  // 能力检测：老 WebView（如 macOS 10.15）无 Intl.Segmenter
  const SegmenterCtor = getSegmenterConstructor();
  if (!SegmenterCtor) return null;
  const text = segments
    .map((segment) => segment.text)
    .join(" ")
    .toLocaleLowerCase();
  if (!text.trim()) return null;

  const segmenter = new SegmenterCtor("zh", { granularity: "word" });
  const tokens: string[] = [];
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike) continue;
    const word = segment.trim();
    if (word) tokens.push(word);
  }

  const counts = new Map<string, number>();
  const bump = (word: string) => counts.set(word, (counts.get(word) ?? 0) + 1);

  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    // 单字词信息量低（的/好/是……），一律排除；超长词截到上限
    if (word.length < 2) continue;
    const candidate =
      word.length > maxLength ? word.slice(0, maxLength) : word;
    if (!STOPWORDS.has(candidate) && !STOPWORDS.has(word)) bump(candidate);

    // 相邻二元合并：两个相邻纯中文实义词成对出现时还原完整术语
    // （如 人工+智能 → 人工智能），总长不超过上限
    const next = tokens[i + 1];
    if (
      next &&
      CJK_ONLY.test(word) &&
      CJK_ONLY.test(next) &&
      isKeywordCandidate(word, maxLength) &&
      isKeywordCandidate(next, maxLength) &&
      word.length + next.length <= maxLength
    ) {
      bump(word + next);
    }
  }
  if (counts.size === 0) return null;

  // 频次优先，同频取更长（信息密度更高）
  let best: string | null = null;
  let bestCount = 0;
  for (const [word, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount && best !== null && word.length > best.length)
    ) {
      best = word;
      bestCount = count;
    }
  }

  // 文件名清洗：去非法字符与空白，清洗后为空则回退
  const sanitized = best?.replace(ILLEGAL_FILENAME, "") ?? "";
  return sanitized.length >= 2 ? sanitized : null;
}
