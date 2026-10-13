# Security

VorteX Axis sits between an AI agent and the devices around a person: microphones, speakers, screens and, with the desktop app, a computer an agent can read and act on. This page says what protects what, what you have to do yourself, and what is not protected. It was written from a review of the code on 2026-10-13 (Axis 0.40.2, desktop app 0.7.7, board firmware 0.18.2).

Report a problem privately rather than in a public issue: on GitHub, the repository's **Security** tab, **Report a vulnerability**. Say what you found, how to see it, and which version.

## The three doors

**The admin side** (`/admin`, `/admin/*`): one token, `AXIS_ADMIN_TOKEN`, sent as a bearer token. It must be 24 characters or more; shorter, or unset, and the admin side is off. Make one with `openssl rand -hex 24`. Compared in constant time; ten wrong tokens from one address shut that address out for five minutes. The admin page keeps the token for the tab, or in the browser's storage when "Remember on this device" is ticked.

**Devices** (`/v1/pair`, the `/v1/client` socket, `/v1/*`): a device pairs once with a short-lived code an admin made (six digits, attempts limited per address) and gets its own token. Axis stores only a hash of it. A device can act only as itself: its own settings, its own volume, the firmware or desktop app meant for its type.

**Agents** (`POST /mcp`): a token an admin made on the Agent tools page, hashed, with the same lockout as the admin side. Each tool can be switched off for every agent. Experimental tools (the desktop tool) are off until an admin switches them on.

## Under a public name

Axis can be reached from outside through a tunnel or reverse proxy. List those names in `AXIS_PUBLIC_HOSTS`: under them `/admin`, the admin API, the Home Assistant blueprint and (unless `AXIS_MCP_PUBLIC` is set) `/mcp` answer 404, so only devices see Axis from outside. Set `AXIS_TRUSTED_PROXIES` to the proxy's address so the lockouts count the real caller and not the proxy.

Two things to get right:
- The proxy must pass the public name as the `Host` header (most do). A proxy that rewrites it to `localhost` makes every outside request look local, and the admin side answers it (it still needs the token).
- Axis itself speaks plain HTTP. Encryption is the proxy's job. Over plain HTTP on a local network, anyone on that network can read what devices say and send.

## On the host

The data folder holds the database: the gateway link's private key, the keys for web push, every token's hash, settings and the activity log. Axis makes the folder and the file readable by its own user only (`700` and `600`), and does the same to its backups, where the folder allows it (network shares may not). Keep the folder off shared storage that other people can read, and keep `.env` (the admin token) the same way.

Words people say are not stored: turns and the live page keep them in memory and drop them after minutes. The activity log keeps times and outcomes, not words.

## The desktop app

The desktop app lets an agent read a computer's screen and, if allowed, click and type on it. It is EXPERIMENTAL.

- Off by default at the hub: the desktop tool is an experimental tool, off until an admin switches it on.
- Per computer, on its admin page: "Let agents read the screen" and "Let agents click and type" (on), "Let agents take screenshots" (off). Axis checks them, and so does the app.
- On the computer: Pause (window, tray or Ctrl+Alt+S) stops everything. A pill at the top of the screen shows while an agent is using it.
- The app never types into a password field, never takes a screenshot while one has the focus, and never presses lock, sign-out, the security screen, Task Manager, Alt+F4, Win+R or Win+X. It opens only Start-menu apps and http(s) addresses, never a path or a command.
- Not yet: a confirmation before sending, posting, deleting or buying (the tool's description asks agents to ask first, and nothing enforces it), and a list of apps an agent may not read or touch.

**Things done later, with nobody watching.** An agent can leave itself a task for later (a timer with something to do). While such a task runs, the desktop tool is look-only: nothing is clicked or typed. It may act only if the person allowed it when the task was set, and Axis asks them that itself, on the device, with its own question; an agent's word that they agreed does not count. This governs Axis's desktop tool only. Whatever else an agent can do through its own harness (send mail, run commands) is not Axis's to limit.

**Updates.** Axis tells a computer to update when it has a newer build; the app downloads it with its own token and checks its size and SHA-256 before swapping it in. Both come from the same Axis, so the check guards against a broken download, not against a hostile Axis. The app refuses an update over plain HTTP unless Axis is on the same computer, the local network or a tailnet. The app is not code-signed yet, so Windows warns when it is first run.

**What an agent sees goes to its model.** Screen text from looks, and screenshots when they are on, are sent to whatever model the agent uses, and they stay in that agent's conversation history. Axis keeps none of it.

## Boards

Boards keep their Wi-Fi password and token in flash. They trust public certificates for `axis+tls://` addresses and refuse self-signed ones. Firmware updates come only from the Axis a board is paired with, checked by MD5 against what Axis said, and a build that does not reach Axis within three minutes is rolled back. Firmware is not signed.

**The flasher page** (`/flash`) is served to anyone who can reach Axis, under a public name too. It holds no secret: the page, the installer and the firmware, which is public.

## Known gaps

- No signed firmware or signed desktop app.
- No confirmation step or block list for the desktop app (see above).
- One admin token for everything; no separate users or roles.
- The admin side is not rate-limited beyond the wrong-token lockout.
