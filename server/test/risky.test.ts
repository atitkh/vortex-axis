import { describe, expect, it } from "vitest";
import { riskyName, sendingWindow, submitKeys, submitText } from "../src/risky.js";

describe("what a desktop action asks the person about first", () => {
  it("asks for names that send, delete, buy or sign out, as whole words in any case", () => {
    for (const name of ["Send", "send now", "Post", "Publish", "Submit order", "Delete", "Remove account", "Buy now", "Purchase", "Pay", "Place order", "Confirm", "Transfer money", "Sign out", "Sign  Out", "Log out", "Uninstall", "Format disk", "Erase", "Reset", "Install", "Accept all"]) {
      expect(riskyName(name), name).toBeDefined();
    }
    expect(riskyName("Sign out")).toBe("sign out");
  });

  it("leaves plain navigation alone", () => {
    for (const name of ["Search", "Settings", "Sent Items", "Posts", "Installed apps", "PayPal", "Home", "Back", "Inbox", "Open", "", undefined]) {
      expect(riskyName(name), String(name)).toBeUndefined();
    }
  });

  it("asks for Enter only where Enter sends: messages, mail, payments", () => {
    expect(submitKeys("enter")).toBe(true);
    expect(submitKeys("Ctrl+Enter")).toBe(true);
    expect(submitKeys("ctrl + enter")).toBe(true);
    expect(submitKeys("tab")).toBe(false);
    expect(submitKeys("alt+enter")).toBe(false);
    expect(sendingWindow("#general - Discord")).toBe(true);
    expect(sendingWindow("Inbox - Outlook")).toBe(true);
    expect(sendingWindow("Checkout - Shop")).toBe(true);
    expect(sendingWindow("Untitled - Notepad")).toBe(false);
    expect(sendingWindow(undefined)).toBe(false);
    expect(submitText("hello\n")).toBe(true);
    expect(submitText("hello")).toBe(false);
  });
});
