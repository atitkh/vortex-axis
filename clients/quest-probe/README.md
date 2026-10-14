# Quest probe (throwaway experiment)

Not part of Axis, not in any release, not linked from the root README. It answers two questions about driving a Quest's 2D panels (Store, Browser, Settings) from the headset itself, without a computer attached.

- **Q1, local app:** can an ordinary sideloaded app reach the headset's own adbd on `127.0.0.1:5555`?
- **Q2, instrumentation:** can a uiautomator instrumentation read and act on the panels, and does its process survive the cable being pulled and the headset sleeping?

## Build

```bash
scripts/build-quest-probe.sh
```

Builds in Docker (the image is made from `clients/quest-probe/Dockerfile`; Gradle's cache is the volume `vortex-axis-quest-probe-gradle`) and copies `quest-probe.apk` and `quest-probe-test.apk` to `$AXIS_DATA_PATH/quest-probe/`. Debug-signed. Re-runnable.

## Install

```bash
adb install -r quest-probe.apk
adb install -r quest-probe-test.apk
```

Both APKs must come from the same build (same debug key).

## Q1: adb from the headset to itself

1. With the cable in: `adb tcpip 5555` (this lasts until the headset reboots).
2. In the headset, open Library, Unknown Sources, "Quest Probe", and press **Run adb handshake (Q1)**. The same can be started from a computer: `adb shell am start -n dev.vortexaxis.questprobe/.MainActivity`.
3. Read the result on the panel, or pull the log (below).

The app opens a socket to `127.0.0.1:5555`, sends an adb `CNXN` (version `0x01000001`, maxdata 256 KiB, `host::`) and reads one reply header.

| Result line | Meaning |
|---|---|
| `answered with AUTH` | adbd is reachable from an app; it wants a key. The next step would be the key exchange, which brings up "Allow USB debugging" on the headset. |
| `answered with CNXN` | reachable and no key asked for (unusual). |
| `answered with STLS` | reachable, adbd wants TLS (wireless-debugging style). |
| `refused` | nothing listening on 5555 (tcpip not on, or reset by a reboot), or blocked for apps. |
| `timeout` | connected or SYN dropped with no answer; probably filtered. |

The key exchange (AUTH with an RSA key, then a `shell:` stream) is implemented in **v2**, below. Q1 by itself still only shows whether adbd answers.

## v2: adb auth + shell from the headset to itself

v2 (app versionName `0.2`) does the full adb AUTH exchange and then runs shell commands over the same connection, with an on-panel UI. The protocol is in `AdbClient.java` (plain Java, no Android deps, so it is unit-tested on a desktop JVM — see `test/AdbClientTest.java`).

Steps:

1. With the cable in, from a computer: `adb install -r quest-probe.apk` then `adb tcpip 5555`. (`tcpip` lasts until the headset reboots; it is **not** persistent across a reboot.)
2. In the headset open the app and press **Connect (auth)**.
3. The first time, the headset shows **Allow USB debugging?** — tick **Always allow from this computer** and accept. The status line counts down (60 s) while it waits. After you accept, the status becomes `connected` with the device banner.
4. Press **Run all read-only checks**. Each line is `PASS`/`FAIL <name> (<ms>)`; the `dump` and `screencap` lines run 3× and show `min`/`median` ms. Paste that one screen back.

What the checks mean:

| Line | Checks |
|---|---|
| `id` | a shell command runs and returns `uid=...` (adbd shell works). |
| `dump` | `uiautomator dump` wrote the active panel's hierarchy and it was read back (panels are introspectable). |
| `windows` / `displays` | `dumpsys` sees the panel windows / displays. |
| `foreground` | the resumed activity is readable. |
| `screencap` | `screencap -p` produced a PNG (byte count). |

A `PASS` line means that command worked over the self-connection; a `FAIL` means it errored or returned nothing (the line carries the reason).

Buttons: **Connect (auth)** / **Disconnect** / **Forget key**; individual read-only checks; and guarded **actions** (tap/swipe/text/Back/Start Settings and a free-form command box). Actions that touch the device (`input`/`am`/`pm`/`settings`/`svc`/`reboot`/`rm`) only run when the **Allow actions** checkbox is ticked; all other commands run freely. Everything is appended to `probe.log`, and **Run all** also overwrites a compact `summary.txt`.

Keys: a 2048-bit RSA key pair is generated once and kept in the app's private files dir, so **Always allow** keeps working across runs. The public key in adb format is also written to the external files dir as `adbkey.pub` for reference. **Forget key** deletes the app's copy (revoke it on the headset separately to fully reset).

To check that **Always allow** persisted: force-stop the app, reopen it, press **Connect (auth)** — it should connect **without** prompting again.

## Q2: instrumentation

Run in the foreground (blocks until it ends; `seconds` defaults to 120):

```bash
adb shell am instrument -w -e seconds 120 \
  dev.vortexaxis.questprobe.test/androidx.test.runner.AndroidJUnitRunner
```

Add `-e swipe true` to do one short vertical swipe at the display centre after the first dump.

Run detached, so it keeps going after the cable is pulled (either form):

```bash
adb shell "nohup am instrument -w -e seconds 1800 dev.vortexaxis.questprobe.test/androidx.test.runner.AndroidJUnitRunner > /dev/null 2>&1 &"
adb shell "am instrument -w -e seconds 1800 dev.vortexaxis.questprobe.test/androidx.test.runner.AndroidJUnitRunner > /dev/null 2>&1 &"
```

Then unplug, let the headset sleep, wake it, plug back in and pull the log.

It writes, once: `q2-dump.xml` (the active window's hierarchy) and a windows summary in `q2.log` (count, then per window: id, display, type, package, title, bounds, active, focused). Then a `heartbeat nodes=N` line every 5 s, then `done`.

Reading the heartbeats: a gap in timestamps means the process was frozen (sleep) and resumed; heartbeats that stop for good without `done` mean it was killed (note the time); `nodes=0` or `dump failed` while it runs means it lived but could not see the panels (for example while asleep).

## Logs

The instrumentation runs in the app's process, so both probes write to the app's external files folder:

```
/sdcard/Android/data/dev.vortexaxis.questprobe/files/
  probe.log      Q1/v2 (and the path, printed at app start)
  summary.txt    v2 'Run all read-only checks' summary (overwritten each run)
  adbkey.pub     v2 public key in adb format (reference)
  q2.log         Q2 summary and heartbeats
  q2-dump.xml    Q2 first dump
```

```bash
adb pull /sdcard/Android/data/dev.vortexaxis.questprobe/files/ quest-probe-logs/
```

If external storage is unavailable, the app writes `probe.log` to its private folder instead (the panel shows which path); read it with `adb shell run-as dev.vortexaxis.questprobe cat files/probe.log`.
