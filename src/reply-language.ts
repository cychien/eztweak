/** The language to answer the user in, named outright. Told only "the language they write in",
 *  the agent read the prompt around the user's few words - English, written by eztweak - as
 *  theirs, and answered in English. */

const TRADITIONAL = 'Traditional Chinese (繁體中文)'
const SIMPLIFIED = 'Simplified Chinese (简体中文)'
const SHELL_LANGUAGE = TRADITIONAL

/** Characters that differ between the two scripts, among the most common in UI feedback. */
const TRADITIONAL_ONLY = new Set(
  '這個們說對會來為點麼時樣過還讓開關後頁設計顏邊題標圖錯單體區塊變擊選擇導覽頭間線條號與種動畫圓細減欄鈕',
)
const SIMPLIFIED_ONLY = new Set(
  '这个们说对会来为点么时样过还让开关后页设计颜边题标图错单体区块变击选择导览头间线条号与种动画圆细减栏钮',
)
const ENGLISH_WORDS =
  /\b(the|a|an|is|are|this|that|it|make|more|less|too|and|to|of|in|on|with|should|looks?|button|text|color|colour|spacing|bigger|smaller)\b/gi

function stripMarkup(text: string): string {
  return text
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[(file|ref|skill) \d+\]/g, ' ')
    .replace(/(^|\s)\/[\w:-]+/g, ' ')
}

function chinese(text: string): string {
  let traditional = 0
  let simplified = 0
  for (const ch of text) {
    if (TRADITIONAL_ONLY.has(ch)) traditional += 1
    if (SIMPLIFIED_ONLY.has(ch)) simplified += 1
  }
  return simplified > traditional ? SIMPLIFIED : TRADITIONAL
}

/** The language `text` is written in, or null when it cannot be told with confidence. */
export function detectLanguage(raw: string): string | null {
  const text = stripMarkup(raw)
  if (/[\u3040-\u30ff]/.test(text)) return 'Japanese (日本語)'
  if (/[\uac00-\ud7af]/.test(text)) return 'Korean (한국어)'
  if (/[\u4e00-\u9fff]/.test(text)) return chinese(text)
  const words = text.match(/[A-Za-z]+/g) ?? []
  if (!words.length) return null
  const english = text.match(ENGLISH_WORDS)?.length ?? 0
  return english > 0 && english * 4 >= words.length ? 'English' : null
}

/** `words` are the user's own, newest first: this turn's before any earlier one. The first that
 *  names its language decides; words in a language this cannot name are quoted instead, which
 *  still says whose language it is. */
export function replyLanguageLine(words: string[]): string {
  const lead = 'Write to the user - replies, progress lines and questions - in'
  for (const said of words) {
    const language = detectLanguage(said)
    if (language === 'English') return `${lead} English, the language of their own words.`
    if (language) {
      return `${lead} ${language}, the language of their own words, even though these instructions are in English.`
    }
  }
  const unnamed = words.map((w) => stripMarkup(w).trim()).find((w) => /\p{L}/u.test(w))
  if (unnamed) {
    const quote = unnamed.length > 80 ? `${unnamed.slice(0, 80)}...` : unnamed
    return `${lead} the language of their own words - "${quote}" - not the English of these instructions.`
  }
  return `${lead} ${SHELL_LANGUAGE}, the review shell's language, since they have not written anything yet.`
}
