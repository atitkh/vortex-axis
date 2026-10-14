package dev.vortexaxis.quest.core;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * How the Quest panel client introduces itself to Axis. Axis treats any client with the `desktop`
 * capability as a computer (server/src/desktop.ts), so that is the only capability it claims: no
 * microphone, speaker or screen (it shows nothing Axis sends).
 */
public final class QuestIdentity {
    /** Was `quest-panels` up to 0.2.0; Axis 0.44.0 and later take either (server/src/clienttypes.ts). */
    public static final String TYPE = "meta-quest";
    public static final String VERSION = "0.3.1";

    private QuestIdentity() {}

    public static AxisLink.Identity create(String version) {
        List<Object> settings = new ArrayList<>(Arrays.asList(
                setting("allowLook", "Let agents read the panels", "Off refuses every look. The person in the headset can also pause the app.", "1"),
                setting("allowInput", "Let agents tap and type", "Off refuses taps, typing, keys, scrolling and opening apps; looking goes on. The app never types into a password field or presses power or sleep.", "1"),
                setting("allowScreenshot", "Let agents take screenshots", "On, an agent may take a small picture of the panel in front when reading it is not enough; the picture goes to the agent's model. Never while a password field has the focus.", "0"),
                setting("autoUpdate", "Update automatically", "When a newer Quest app is on this hub, download it, check it and install it through the headset's adb; the app restarts by itself.", "1")));
        List<Object> actions = new ArrayList<>();
        actions.add(Json.obj("name", "desktop.hello", "label", "Check the headset", "help", "Asks the app whether it can reach the headset's adb, and which version it is."));
        Map<String, Object> describe = Json.obj("settings", settings, "actions", actions, "links", new ArrayList<>());
        return new AxisLink.Identity(TYPE, version, Arrays.asList("desktop"), describe);
    }

    private static Map<String, Object> setting(String key, String label, String help, String def) {
        return Json.obj("key", key, "label", label, "kind", "toggle", "group", "Quest", "help", help, "default", def);
    }
}
