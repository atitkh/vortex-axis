# VorteX Axis

**A device gateway for AI agents: one agent, reachable from every device around you, in one continuous conversation.**

You already have an agent (in [OpenClaw](https://docs.openclaw.ai), or any model behind a chat endpoint). Axis gives it ears, a voice, screens and hands: small boards with a microphone and a face, a web page on your phone, your computer. Say something to whichever is nearest; the same agent answers, and it can speak, ask you a question or show a picture on any of them.

Axis is a bridge, not an agent. It does not think; it listens, routes and speaks.

<p align="center">
  <img src="docs/media/face-states.gif" alt="The VorteX face going from idle to listening, thinking and speaking, and back to idle" width="480">
</p>

```
 devices                          Axis                          behind it
 -------                          ----                          ---------
 boards (ESP32-S3)  ─┐                                       ┌─ your agent: an OpenClaw gateway,
 web page / phone   ─┤                                       │   or any OpenAI-style chat endpoint
 computer (Windows) ─┼─ one socket ─▶  pairing, settings,  ──┤
 headset (Quest)    ─┘   per device    turns, wake word,     ├─ speech recognition
                                       tools for the agent   └─ speech synthesis (both come with it)
```

## The face

Every board, and the web page, shows the same face. It listens, thinks, speaks and rests, and while the agent works the dots leave the ring and form an icon for what it is doing.

<table align="center">
  <tr>
    <td align="center"><img src="docs/media/face-idle.gif" alt="Idle" width="200"><br><sub>Idle</sub></td>
    <td align="center"><img src="docs/media/face-listening.gif" alt="Listening" width="200"><br><sub>Listening</sub></td>
    <td align="center"><img src="docs/media/face-thinking.gif" alt="Thinking" width="200"><br><sub>Thinking</sub></td>
    <td align="center"><img src="docs/media/face-speaking.gif" alt="Speaking" width="200"><br><sub>Speaking</sub></td>
  </tr>
</table>

<p align="center">
  <img src="docs/media/face-thinking-tools.gif" alt="The thinking face forming a house, then a magnifier, as the agent picks up tools" width="320"><br>
  <sub>Thinking while the agent uses a tool: the dots form a house, then a magnifier.</sub>
</p>

[docs/face.md](docs/face.md) has every look to the pixel.

## What you get

- **Talk to your agent anywhere:** a wake word or a tap on a board, a tap or a held press on the web page, a key on your computer. When several devices hear you, one answers.
- **The agent can reach you:** it speaks on a device, a location or everywhere; asks a question with choices you tap or say; sets timers; shows pictures; keeps a long task's progress on every screen; sends a notification to your phone when you are away.
- **Thin devices:** a device captures and plays audio and shows a face. Speech, settings and the agent link live in Axis, so every device behaves the same and is set up once.
- **Local speech included:** recognition, synthesis and voiceprints run on the CPU beside Axis. Point it at any OpenAI-style audio API instead if you prefer.
- **An admin page:** devices, shared settings, a live view of each turn as it happens, a system map of the devices and services, profiles per device (power saver, silent: replies shown as text), wake words, firmware and app updates, Home Assistant, backups.
- **Tools for any agent:** OpenClaw gets them through its gateway; anything else through MCP.
- **Your computer and headset, experimentally:** a Windows app, and an app for a Meta Quest's 2D panels, let the agent read the screen and act on it, off until you switch it on. Read [SECURITY.md](SECURITY.md) first.

## Quick start

You need Docker. Speech models are fetched on first start (about 250 MB).

```bash
mkdir vortex-axis && cd vortex-axis
curl -fLO https://raw.githubusercontent.com/atitkh/vortex-axis/main/compose.release.yaml
curl -fL  https://raw.githubusercontent.com/atitkh/vortex-axis/main/.env.example -o .env
mv compose.release.yaml compose.yaml
mkdir -p data models

# The one thing you must set: an admin token, 24 characters or more.
sed -i "s/^AXIS_ADMIN_TOKEN=.*/AXIS_ADMIN_TOKEN=$(openssl rand -hex 24)/" .env
grep AXIS_ADMIN_TOKEN .env      # you sign in with this

docker compose up -d
```

Open `http://<this machine>:8440/admin`, sign in with the token, and follow **Getting started** on the Overview:

1. **Speech is working.** It is, once the models have been fetched.
2. **An agent answers.** Pair with an OpenClaw gateway (paste a setup code), or give Axis the address of any OpenAI-style chat endpoint, such as a local model.
3. **A first device.** Make a pairing code, open `http://<this machine>:8440/` in a browser and enter it. That browser is now a device: type to your agent.
4. **Say something.**

To speak from a browser, it needs `https` or `localhost` (browsers allow the microphone nowhere else). [docs/setup.md](docs/setup.md) shows two ways to give Axis an HTTPS address, and how to put it on a public name safely.

## Devices

| Device | What it is | How it joins |
| --- | --- | --- |
| Web page | Any browser or phone; installs as an app, with notifications | Open Axis's address, enter a pairing code |
| Board | Waveshare ESP32-S3-Touch-AMOLED-1.8: face, microphone, speaker, wake word | Flash once from the browser or by cable ([docs/hardware.md](docs/hardware.md)), then set up from your phone; updates over Wi-Fi from the admin page |
| Round board (new) | Waveshare ESP32-S3-Touch-AMOLED-1.75: the same, on a round screen, with two microphones | The same as the 1.8; new, not yet tested in everyday use |
| Computer | Windows app (experimental): talk key, speakers, and the agent's hands on the screen | Download from the admin page's **Add a device**, enter a pairing code; it updates itself |
| Meta Quest | Android app (experimental): the agent reads and uses the headset's 2D panels (Store, Browser, Settings, Android apps); no voice | Developer mode, then install the APK with `adb`, enter a pairing code ([docs/hardware.md](docs/hardware.md)); it updates itself |

A release image comes with the board firmware, the Windows app and the Quest app inside it, so a new hub can update boards and offer the apps straight away. Making your own device: [docs/client-guide.md](docs/client-guide.md) is the contract, `protocol/` the message definitions.

## Where to read more

- [docs/setup.md](docs/setup.md): addresses and HTTPS, agents and MCP, backups, speech, pairing with OpenClaw, the admin API, developing.
- [docs/hardware.md](docs/hardware.md): the board, the computer app, a phone, and making your own device.
- [docs/design.md](docs/design.md): how it works and why.
- [docs/face.md](docs/face.md): the face, to the pixel.
- [docs/client-guide.md](docs/client-guide.md): what a new client type has to declare and do.
- [docs/client-parity.md](docs/client-parity.md): how the existing clients differ in how they work.
- [docs/release.md](docs/release.md): cutting a release and the checks that go with it.
- [protocol/README.md](protocol/README.md): the client protocol, version 1.
- [firmware/README.md](firmware/README.md): firmware for the boards.
- [flasher/README.md](flasher/README.md): the browser page that flashes a new board over USB.
- [clients/windows-desktop/README.md](clients/windows-desktop/README.md): the Windows desktop app.
- [clients/macos-desktop/README.md](clients/macos-desktop/README.md): the Mac menu bar app.
- [clients/quest-client/README.md](clients/quest-client/README.md): the Meta Quest app.
- [CONTRIBUTING.md](CONTRIBUTING.md): building, testing and sending a change.
- [SECURITY.md](SECURITY.md): what protects what, and what does not.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.

## Licence

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for what it includes from others.
