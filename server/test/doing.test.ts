import { describe, expect, it } from "vitest";
import { doingFor } from "../src/doing.js";

describe("what kind of work a tool is", () => {
  it("reads it from the tool's name, the narrower kind first", () => {
    const kinds: Record<string, string> = {
      web_search: "search",
      web_fetch: "web",
      browser: "web",
      memory_search: "memory",
      mcp__HomeAssistant__GetLiveContext: "home",
      mcp__HomeAssistant__HassLightSet: "home",
      vortex_axis_timer: "timer",
      cron: "timer",
      mcp__LogsTrackerMCP__get_today_tasks: "list",
      image_generate: "image",
      view_image: "image",
      exec: "code",
      apply_patch: "files",
      read: "files",
      vortex_axis_say: "message",
      sessions_send: "message",
      sessions_spawn: "tool",
      something_unheard_of: "tool",
    };
    for (const [tool, kind] of Object.entries(kinds)) expect([tool, doingFor(tool)]).toEqual([tool, kind]);
    // Seen on the real gateway: the search tool arrives under its server's name, and so does the agent's own housekeeping.
    expect(doingFor("mcp__openclaw__web_search")).toBe("search");
    for (const tool of ["ToolSearch", "mcp__openclaw__progress_card", "TodoWrite", "Skill"]) expect([tool, doingFor(tool)]).toEqual([tool, undefined]);
  });
});
