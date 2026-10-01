// Characters that hide or reorder text (review W3C-05). Stripped from anything a session or the
// box wrote before a client or a terminal sees it:
// - C0/C1 controls except tab, newline and carriage return (terminal escapes, bells).
// - Unicode format characters \p{Cf}: bidi embeddings and overrides U+202A-202E, isolates
//   U+2066-2069, zero-width U+200B-200F, word joiner U+2060, BOM U+FEFF, and more.
// - Unicode's Default_Ignorable_Code_Point set \p{DI} (R4-02): code points a renderer shows as
//   nothing. A hand list kept missing some (R3-05, then R4-02), so the property is used instead.
//   It covers the whole tag block U+E0000-E0FFF ("ASCII smuggling"), every variation selector
//   (U+FE00-FE0F, U+E0100-E01EF and the Mongolian U+180B-180F: a run of them can carry hidden
//   bytes), the combining grapheme joiner U+034F, the Khmer inherent vowels U+17B4/17B5, the
//   Hangul fillers U+115F, U+1160, U+3164, U+FFA0, and the reserved U+FFF0-FFF8 and U+2065.
//   An emoji written with VS16 loses only the selector.
// - Invisible characters that are not default-ignorable: the line and paragraph separators
//   U+2028/2029 (they break lines in some viewers) and the Braille blank U+2800.
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\p{DI}\u2028\u2029\u2800]/gu

/** `text` without control, format, default-ignorable and invisible filler characters. Run it before truncating or scrubbing. */
export function stripUnsafe(text: string): string {
  return text.replace(UNSAFE, "")
}
