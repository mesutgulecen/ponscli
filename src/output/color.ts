export type ColorMode = 'auto' | 'always' | 'never'

const ESC = '\u001b['

const CODES = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  cyan: `${ESC}36m`,
  grey: `${ESC}90m`,
} as const

export type ColorName = Exclude<keyof typeof CODES, 'reset'>

export interface Painter {
  readonly enabled: boolean
  (name: ColorName, text: string): string
}

/**
 * Resolve whether to emit ANSI codes.
 *
 * `NO_COLOR` is honoured unconditionally under `auto`, per the informal
 * standard: any non-empty value disables colour. An explicit `always` from the
 * user overrides it, because that is what "always" means.
 */
export function shouldColorize(mode: ColorMode, env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (mode === 'never') return false
  if (mode === 'always') return true
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false
  if (env['TERM'] === 'dumb') return false
  return isTTY
}

export function createPainter(enabled: boolean): Painter {
  const paint = (name: ColorName, text: string): string =>
    enabled ? `${CODES[name]}${text}${CODES.reset}` : text
  return Object.assign(paint, { enabled })
}

// Matching an escape sequence requires the escape character; the rule that
// forbids it exists for regexes that contain one by accident.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g

/**
 * Code points that occupy two terminal columns: CJK, Hangul, the fullwidth
 * forms, and the emoji blocks. Memecoin names are exactly where these turn up,
 * so a table that measures them in code units misaligns on the first launch
 * named in Chinese.
 */
const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols
  [0x3041, 0x33ff], // Kana, Hangul compatibility Jamo, CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f9ff], // Emoji and pictographs
  [0x20000, 0x3fffd], // CJK extensions B and beyond
]

function codePointWidth(code: number): number {
  // Combining marks, variation selectors and zero-width joiners render into
  // the preceding cell rather than a new one.
  if (code === 0x200d || (code >= 0x0300 && code <= 0x036f) || (code >= 0xfe00 && code <= 0xfe0f)) {
    return 0
  }
  return WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? 2 : 1
}

/**
 * Width of a string in terminal columns, with ANSI escape sequences discounted.
 *
 * Not `.length`: that counts UTF-16 code units, which is wrong twice over: an
 * emoji is two units and one glyph, and a CJK ideograph is one unit and two
 * columns.
 */
export function visibleWidth(text: string): number {
  let width = 0
  for (const character of text.replace(ANSI_PATTERN, '')) {
    width += codePointWidth(character.codePointAt(0) ?? 0)
  }
  return width
}
