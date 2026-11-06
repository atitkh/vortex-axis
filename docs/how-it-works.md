# How VorteX Axis works

This page is for someone who has just found the repository and wants to know what Axis does, where a conversation goes, what you would have to run, and whether it fits what they have. It is the long version of the README's first screen. [design.md](design.md) is the detailed spec, and [setup.md](setup.md) has the commands.

## What it is, and what it is not

Axis is a **bridge between an AI agent and the devices around you**. You already have an agent: an [OpenClaw](https://docs.openclaw.ai) gateway, or any model behind an OpenAI-style chat endpoint. Axis gives that agent ears, a voice, screens and, on a computer, hands.

- Axis **does not think**. It has no model of its own, no memory of what you said and no personality. It listens, turns speech into text, passes the text to your agent, and speaks what the agent answers.
- Axis is **one conversation, many doors**. A desk board, a phone and a PC are all ways into the same agent. Whichever you speak to answers, and you can follow up on another.
- Axis is **a server you run**. It is one Docker container (plus small speech containers beside it), and your devices connect to it. There is no cloud service in the middle unless you choose one for speech.

It is a good fit if you want your own agent to be something you can talk to around the house or desk, with screens that show what it is doing. It is not a replacement for the agent, and it is not a finished consumer product (see the last section).

## The picture

```
 devices                            Axis                              behind it
 -------                            ----                              ---------
 boards (ESP32-S3)   ─┐                                           ┌─ your agent
 web page / phone    ─┤                                           │    an OpenClaw gateway, or any
 Windows / Mac app   ─┼── one socket per ──▶ pairing, settings,  ─┤    OpenAI-style chat endpoint
 Quest headset       ─┘   device             wake word, routing,  │
                                            tools for the agent   ├─ speech recognition  (local or API)
                                                                  └─ speech synthesis    (local or API)
```

Every device speaks the same small WebSocket protocol ([protocol/README.md](../protocol/README.md)). A device says what it can do (microphone, speaker, screen, touch, buttons), and Axis uses that, not its brand, to decide what to send it.

## What happens when you say something

1. **Wake word.** A board listens for its wake word on the device itself, offline. Nothing is sent until it hears it. If two devices hear it at once, they each report a score and Axis picks the best one; the others stand down.
2. **Audio goes to Axis.** The device sends what you say, as a short audio stream, over its socket.
3. **Speech recognition.** Axis turns the audio into text with the recognition service (a small local model by default, or any OpenAI-style audio API, or ElevenLabs).
4. **Axis tells the agent who is speaking.** The text goes to your agent with one short line in front, such as `[from: Desk, type: esp32s3-speaker, location: office, can: mic+speaker+screen]`. The agent can use that: it knows a spoken answer should be short, and that you are in the office.
5. **The agent answers.** With OpenClaw, Axis sends the turn to the agent over the gateway and reads the reply as it streams back. With a plain chat endpoint, it sends the text with a system prompt that says it is a voice assistant.
6. **Speech synthesis.** Axis turns the reply into audio and streams it to the device that asked. Text and pictures in the reply go to its screen.
7. **The face shows each step.** The device shows listening, thinking, speaking and idle. While the agent works, the face shows an icon for what it is doing.

A typed turn from the web page or the Windows app skips steps 1 to 3 and the reply comes back as text.

## Where the conversation goes

**To one place.** All devices share one conversation with the agent. Axis does not keep the conversation: the history lives in your agent. Axis stores the pairing, settings, timers, reminders and an activity log, and by design **not** the audio or the conversation history ([design.md section 8](design.md#8-storage)).

**Replies go back to whoever asked.** When the agent starts something unprompted, such as a timer going off or a message it wants to say, Axis picks a device: the last one you used for input, falling back after a while to a default you set. If that device is offline, the next one that has what the message needs (a speaker to say it, a screen to show it) gets it.

**You choose the agent in one place.** On the admin page, or with `AXIS_AGENT_ID`:

| You have | How to connect it | What the agent gets |
| --- | --- | --- |
| An OpenClaw gateway | Paste a setup code on the admin page, approve Axis as a device on the gateway ([setup.md](setup.md#pairing-axis-with-openclaw)) | Turns over the gateway, Axis's tools as node commands, your progress card and questions on the devices. Pick an agent by name, or the gateway's default answers |
| Any OpenAI-style chat endpoint (a local model, another harness) | Give its address on the admin page | Your words as chat turns with a system prompt. Tools through MCP |
| An agent harness that speaks MCP | Add Axis as an MCP server ([setup.md](setup.md#agents-and-tools)) | The same tools, over HTTP |

With OpenClaw, Axis uses two links over one identity: an **operator link** that sends turns and reads replies, progress and questions, and a **node link** that offers Axis's commands to agents. Both appear on the admin page and in `GET /admin/gateway`.

## Switching conversations

Axis normally uses one conversation, Axis's own voice conversation with the agent. You can point **all** devices at another of your OpenClaw conversations and come back:

- "Attach to internship hunt": Axis finds the conversation by the name you say. A name in full wins. If several fit, it asks which.
- While attached, whichever device you speak to talks into that conversation, with that conversation's agent.
- Detaching returns to the voice conversation. It also lets go by itself after 30 minutes without a turn, so words meant for the assistant do not land in a thread you forgot about.
- It is one setting for the whole hub, not per device. Two devices that woke at once would otherwise talk into two places.

This is the `vortex.axis.session` tool (`attach`, `detach`, `current`, `list`), so the agent can do it for you as well. It needs an OpenClaw gateway; a plain chat endpoint has one conversation.

## What the agent can do through Axis

The agent gets eleven tools, plus an experimental computer tool that stays off until you switch it on:

- **say** and **show**: speak a short message, or put a picture on a screen for a few seconds
- **ask**: put a question with choices to you and wait for the answer, on any device with buttons or a screen
- **timer** and **reminder**: set, list and cancel
- **clients** and **sense**: which devices are online, what each can do, and how they are doing (battery, state)
- **config**: change a device's settings, such as volume
- **progress**: show how long its work is going. With OpenClaw this happens by itself from the agent's own plan
- **session**: switch conversations (above)
- **diag** and **admin**: diagnostics and administration

An admin can switch any tool off for every agent from the Agent page.

## Devices

| Device | Notes |
| --- | --- |
| Web page | Any browser or phone. Microphone needs `https` or `localhost` |
| Board (Waveshare ESP32-S3 AMOLED, 1.8 and 1.75) | Face, microphone, speaker, offline wake word. Flashed from the browser, updates over Wi-Fi |
| Windows app | Talk key, speakers, optional agent control of the screen (off until you turn it on) |
| Mac app | Experimental. Menu bar app. Link stability after sleep is still being worked on |
| Meta Quest | Experimental. The agent reads and uses 2D panels. No voice |

You can write your own client: [client-guide.md](client-guide.md) is the contract.

## What you need to run it

- **Docker.** The release compose file starts Axis and three small CPU speech services (recognition, synthesis, voice recognition). The models are fetched on first start, about 250 MB.
- **An admin token** (24+ characters) in `.env`. You sign in to the admin page with it.
- **An agent** to answer.
- **A way to reach Axis.** On your network is enough for boards and the web page on `localhost`. A browser microphone needs HTTPS ([setup.md](setup.md) shows two ways).

Axis keeps its data in one SQLite file in one folder you choose. The file holds token hashes and the gateway's identity key, so keep that folder private. It can copy itself to another disk on a schedule.

## Is it for you?

**Works day to day:** the web page, the boards, and the Windows app, with an OpenClaw gateway or a chat endpoint. This is what the author uses.

**Rough or experimental:**
- The Mac app and the Quest app, and the agent control of a computer's screen (read [SECURITY.md](../SECURITY.md) before switching that on).
- The boards are two specific Waveshare models. Without one, the web page and the apps are what you can use.
- There is no barge-in (speaking over a reply does not stop it), no presence-based routing, and no backup voice if the speech services are down ([design.md section 12](design.md#12-roadmap-and-known-limitations)).
- Latency depends on your agent and your speech setup. There is no promised target.

If you want a voice and a screen for an agent you already run, and you are comfortable with Docker and an admin page, it should fit. If you want a boxed device that works the moment it is plugged in, it is not that yet.

## Where to go next

- Try it: the [README's quick start](../README.md#quick-start).
- Pair with OpenClaw: [setup.md](setup.md#pairing-axis-with-openclaw).
- Understand the choices in depth: [design.md](design.md).
- Make a device: [client-guide.md](client-guide.md) and [hardware.md](hardware.md).
