/**
 * What an agent is doing while a person waits for its answer, as one of a few
 * kinds a small screen can show with an icon. An agent names the tool it has
 * picked up; this says which kind of work that is. A tool nobody has heard of
 * is still work, and is shown as such.
 *
 * The kinds are the icons of docs/face.md section 8. A client draws the ones
 * it knows and ignores the rest.
 */
export const DOING = ["search", "web", "home", "calendar", "list", "files", "code", "timer", "message", "memory", "image", "computer", "tool"] as const;
export type Doing = (typeof DOING)[number];

/** Read in order: the first that fits wins, so the narrower come before the wider. */
const RULES: [RegExp, Doing][] = [
  // Looking at or using a computer: Axis's desktop tool, a harness's computer use, a node's screen snapshot.
  [/desktop|computer|screen_?snapshot|screen\.snapshot/, "computer"],
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

/**
 * An agent's own housekeeping: looking up which tools it has, keeping its plan, loading a skill.
 * It says nothing about what the agent is doing for the person, so it is not shown.
 */
const HOUSEKEEPING = /^(toolsearch|todowrite|progress_card|update_plan|skill|get_goal|update_goal|session_status)$/;

/** The kind of work a tool of that name is. Undefined for one that is not worth showing. */
export function doingFor(tool: string): Doing | undefined {
  const name = tool.toLowerCase();
  // A tool reached through a server carries the server's name in front: mcp__server__tool.
  if (HOUSEKEEPING.test(name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, ""))) return undefined;
  for (const [pattern, doing] of RULES) if (pattern.test(name)) return doing;
  return "tool";
}
