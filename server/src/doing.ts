/**
 * What an agent is doing while a person waits for its answer, as one of a few
 * kinds a small screen can show with an icon. An agent names the tool it has
 * picked up; this says which kind of work that is. A tool nobody has heard of
 * is still work, and is shown as such.
 *
 * The kinds are the icons of docs/face.md section 8. A client draws the ones
 * it knows and ignores the rest.
 */
export const DOING = ["search", "web", "home", "calendar", "list", "files", "code", "timer", "message", "memory", "image", "tool"] as const;
export type Doing = (typeof DOING)[number];

/** Read in order: the first that fits wins, so the narrower come before the wider. */
const RULES: [RegExp, Doing][] = [
  [/timer|alarm|remind|cron|schedul/, "timer"],
  [/memory|recall|remember|wiki/, "memory"],
  [/image|photo|picture|camera|video|screenshot|vision/, "image"],
  [/calendar|event|agenda/, "calendar"],
  [/todo|task|list|tracker|wallet|note/, "list"],
  [/hass|home.?assistant|light|switch|climate|thermostat|scene|media_?player|live_?context/, "home"],
  [/search|find|grep|glob|lookup|query/, "search"],
  [/web|fetch|browse|http|url|weather/, "web"],
  [/say|ask|message|send|notify|mail|discord|slack|telegram|whatsapp|sms|speak/, "message"],
  [/exec|bash|shell|process|terminal|run|code|python|script|command/, "code"],
  [/read|write|edit|patch|file|fs|document|pdf|sheet|doc/, "files"],
];

/** The kind of work a tool of that name is. */
export function doingFor(tool: string): Doing {
  const name = tool.toLowerCase();
  for (const [pattern, doing] of RULES) if (pattern.test(name)) return doing;
  return "tool";
}
