/**
 * ElevenLabs v3/v4 voices act on audio tags written in square brackets, such as [whispers] or
 * [sighs]. Everything about them lives here: which models take them, and how to take them out of
 * text that is shown or sent to a voice that would read them aloud.
 */

/** Model ids (by prefix) that understand audio tags. web/speech-entries.js keeps the same list; a test checks they agree. */
export const AUDIO_TAG_MODEL_PREFIXES = ["eleven_v4", "eleven_v3"] as const;

/** Whether a speech entry's setting lets audio tags through: "auto" uses them where the model supports them. */
export type AudioTagsSetting = "auto" | "off";
export const AUDIO_TAGS_SETTINGS: readonly AudioTagsSetting[] = ["auto", "off"];

/** Whether the model behind an entry can act on audio tags, whatever the setting says. */
export function supportsAudioTags(entry: { kind?: string; model?: string }): boolean {
  if (entry.kind !== "elevenlabs") return false;
  const model = (entry.model ?? "").trim().toLowerCase();
  return AUDIO_TAG_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

/** Whether tags are sent to this entry: the model supports them and the admin has not turned them off. */
export function effectiveAudioTags(entry: { kind?: string; model?: string; audioTags?: string }): boolean {
  return supportsAudioTags(entry) && entry.audioTags !== "off";
}

/**
 * A tag: letters, spaces, hyphens or apostrophes, 1 to 40 of them, in single square brackets. Not
 * a markdown link or footnote (followed by "(" or ":"), not nested, and not a checkbox or a lone letter.
 */
const TAG = /(?<!\[)\[([A-Za-z][A-Za-z '-]{0,39})\](?![\](:])[ \t]*/g;

const isTag = (inner: string) => (inner.match(/[A-Za-z]/g) ?? []).length >= 2;

/** Takes audio tags out, with the space that was after them. Anything else, including other brackets, stays as it is. */
export function stripAudioTags(text: string): string {
  if (!text.includes("[")) return text;
  return text.replace(TAG, (whole, inner: string, offset: number) => {
    if (!isTag(inner)) return whole;
    const before = offset === 0 || /\s/.test(text[offset - 1]!);
    // "word[tag] more" keeps one space; "word [tag] more" and "[tag] more" lose the tag's own.
    if (before) return "";
    return whole.endsWith(" ") || whole.endsWith("\t") ? " " : "";
  });
}

/** Whether the text holds tags and nothing else: a fragment no voice should be asked to say alone. */
export function isTagsOnly(text: string): boolean {
  const stripped = stripAudioTags(text);
  return stripped !== text && stripped.trim() === "";
}
