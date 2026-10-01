// Characters that hide or reorder text (review W3C-05). Stripped from anything a session or the
// box wrote before a client or a terminal sees it:
// - C0/C1 controls except tab, newline and carriage return (terminal escapes, bells).
// - Unicode format characters \p{Cf}: bidi embeddings and overrides U+202A-202E, isolates
//   U+2066-2069, zero-width U+200B-200F, word joiner U+2060, BOM U+FEFF, and more.
// - The whole tag block U+E0000-E007F, including its unassigned code points (invisible "ASCII
//   smuggling" text).
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}\u{E0000}-\u{E007F}]/gu

/** `text` without control, format and tag characters. Run it before truncating or scrubbing. */
export function stripUnsafe(text: string): string {
  return text.replace(UNSAFE, "")
}
