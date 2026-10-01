// Characters that hide or reorder text (review W3C-05). Stripped from anything a session or the
// box wrote before a client or a terminal sees it:
// - C0/C1 controls except tab, newline and carriage return (terminal escapes, bells).
// - Unicode format characters \p{Cf}: bidi embeddings and overrides U+202A-202E, isolates
//   U+2066-2069, zero-width U+200B-200F, word joiner U+2060, BOM U+FEFF, and more.
// - The whole tag block U+E0000-E007F, including its unassigned code points (invisible "ASCII
//   smuggling" text).
// - Invisible characters outside \p{Cf} (R3-05): variation selectors U+FE00-FE0F and
//   U+E0100-E01EF (a run of them can carry hidden bytes), the line and paragraph separators
//   U+2028/2029, the Hangul fillers U+115F, U+1160, U+3164, U+FFA0, and the Braille blank U+2800.
//   An emoji written with VS16 loses only the selector.
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\u{E0000}-\u{E007F}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u2028\u2029\u115F\u1160\u3164\uFFA0\u2800]/gu

/** `text` without control, format, tag and invisible filler characters. Run it before truncating or scrubbing. */
export function stripUnsafe(text: string): string {
  return text.replace(UNSAFE, "")
}
