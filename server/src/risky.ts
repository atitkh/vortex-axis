/**
 * What makes a desktop action worth asking the person about first: an element whose name says it sends,
 * deletes, buys or signs out, or Enter pressed in a window where Enter sends a message or a payment.
 * When unsure about something that goes out or cannot be undone, it asks; plain navigation ("Search",
 * "Settings", "Sent Items") does not.
 */

/** Words (whole words, any case) in an element's name that make clicking or dragging it risky. */
const RISKY_WORDS = [
  "send", "post", "publish", "submit", "delete", "remove", "buy", "purchase", "pay", "order", "confirm",
  "transfer", "sign out", "log out", "uninstall", "format", "erase", "reset", "install", "accept",
];

/** Words in a window's title that say Enter there sends something: messages, mail, payments. */
const SENDING_WINDOWS = [
  "mail", "inbox", "outlook", "gmail", "message", "messages", "messenger", "chat", "discord", "slack", "teams",
  "whatsapp", "telegram", "signal", "compose", "reply", "checkout", "payment", "pay", "cart", "bank", "paypal",
  "transfer", "wallet",
];

const wordsIn = (list: string[]) => new RegExp(`\\b(${list.map((w) => w.replace(/ /g, "\\s+")).join("|")})\\b`, "i");
const RISKY = wordsIn(RISKY_WORDS);
const SENDING = wordsIn(SENDING_WINDOWS);

/** The risky word in an element's name, or undefined. */
export function riskyName(name: string | undefined): string | undefined {
  const found = name ? RISKY.exec(name) : null;
  return found ? found[1]!.toLowerCase().replace(/\s+/g, " ") : undefined;
}

/** True when the window's title says Enter there sends a message or a payment. */
export function sendingWindow(title: string | undefined): boolean {
  return Boolean(title && SENDING.test(title));
}

/** Enter, alone or with ctrl (or the numpad's), as a key combination an agent sends. */
export function submitKeys(keys: string | undefined): boolean {
  if (!keys) return false;
  const parts = keys.toLowerCase().replace(/\s+/g, "").split("+");
  const key = parts.at(-1);
  const mods = parts.slice(0, -1);
  return (key === "enter" || key === "return") && mods.every((m) => m === "ctrl" || m === "control");
}

/** Typed text that ends a line, which in a chat or mail box sends it. */
export function submitText(text: string | undefined): boolean {
  return Boolean(text && /[\r\n]/.test(text));
}
