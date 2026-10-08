/** What came of a question put to a person on a client. */
export interface AskResult {
  /** The choice picked, exactly as it was offered. Null when nothing matched or nobody answered. */
  answer: string | null;
  /** What the person said or typed, when they did. */
  said?: string;
  how?: "tap" | "voice" | "typed";
  timedOut?: boolean;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth"];
const NUMBERS = [
  ["one", "1"],
  ["two", "2"],
  ["three", "3"],
  ["four", "4"],
  ["five", "5"],
  ["six", "6"],
];
const YES = ["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "please do", "go ahead", "do it", "correct", "affirmative"];
const NO = ["no", "nope", "nah", "no thanks", "don't", "do not", "cancel", "never mind", "negative"];

/** Lower case, with punctuation gone and single spaces, padded so whole words can be searched for. */
function plain(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, " ").trim()} `;
}

/**
 * Finds the choice a person meant by what they said. A choice named in full
 * wins, the longest when several are; then "the second one"; then plain yes
 * and no when those are among the choices. Undefined when nothing fits, which
 * is left to whoever asked.
 */
export function matchChoice(said: string, choices: readonly string[]): string | undefined {
  const heard = plain(said);
  const named = choices
    .filter((choice) => plain(choice).trim() && heard.includes(plain(choice)))
    .sort((a, b) => b.length - a.length);
  if (named.length) return named[0];

  // "The second one" names the second, not the first: ordinals are read before plain numbers.
  const byOrdinal = choices.filter((_, i) => heard.includes(` ${ORDINALS[i]} `));
  if (byOrdinal.length === 1) return byOrdinal[0];
  if (!byOrdinal.length) {
    const byNumber = choices.filter((_, i) => NUMBERS[i]!.some((word) => heard.includes(` ${word} `)));
    if (byNumber.length === 1) return byNumber[0];
  }

  const yes = choices.find((choice) => plain(choice) === " yes ");
  const no = choices.find((choice) => plain(choice) === " no ");
  if (yes && no) {
    const saysYes = YES.some((word) => heard.includes(` ${word} `));
    const saysNo = NO.some((word) => heard.includes(` ${word} `));
    if (saysYes !== saysNo) return saysYes ? yes : no;
  }
  return undefined;
}
