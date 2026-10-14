package dev.vortexaxis.quest;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import dev.vortexaxis.quest.core.AdbLink;
import dev.vortexaxis.quest.core.AxisAddress;
import dev.vortexaxis.quest.core.AxisLink;

/**
 * The app's one window: Pair when there is no pairing, else the state of the two links, Pause,
 * Set up, Test, Recently and the diagnostics. Drawn in code, in the Windows app's colours, large
 * enough to read and hit in a headset.
 */
public final class MainActivity extends Activity {
    static final int BG = 0xFF000000, TEXT = 0xFFE9E9E6, DIM = 0xFF8D8C86, LINE = 0xFF262624, ACCENT = 0xFF6FD4EF,
            GOOD = 0xFF3CF08C, BAD = 0xFFFF6A5C, WARN = 0xFFF2B84B, CARD = 0xFF0E0E0D;

    private Hub hub;
    private final Runnable refresh = this::render;
    private boolean showingMain;
    // Main screen parts, refreshed in place.
    private TextView pill, who, adbState, adbDetail, testResult, recent;
    private Switch pause, faster;
    private Button allow;
    private View help;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        hub = Hub.get(this);
    }

    @Override protected void onResume() {
        super.onResume();
        hub.watch(refresh);
        if (hub.pairing() != null) {
            AxisService.start(this);
            // Back in front: connect again if the link had stopped.
            hub.connect();
        }
        build();
    }

    @Override protected void onPause() {
        hub.unwatch(refresh);
        super.onPause();
    }

    private void build() {
        showingMain = hub.pairing() != null;
        setContentView(showingMain ? mainScreen() : pairScreen());
        render();
    }

    // ---- pairing ---------------------------------------------------------------

    private View pairScreen() {
        LinearLayout col = column();
        col.addView(title("Pair with VorteX Axis"));
        col.addView(text("On Axis's admin page, choose Add a device and make a code. Type Axis's address and the code here. A setup string (axis://…) carries both.", 20, DIM));
        EditText address = field("Axis address, such as 192.168.1.20:8440", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setText(hub.savedAddress());
        EditText code = field("Pairing code, such as 123-456", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        EditText name = field("Name for this headset", InputType.TYPE_CLASS_TEXT);
        name.setText(hub.savedName());
        col.addView(label("Address"));
        col.addView(address);
        col.addView(label("Code"));
        col.addView(code);
        col.addView(label("Name"));
        col.addView(name);
        TextView status = text("", 20, DIM);
        Button pair = button("Pair", true);
        pair.setOnClickListener(v -> {
            String a = address.getText().toString(), c = code.getText().toString(), n = name.getText().toString().trim();
            try {
                AxisAddress parsed = AxisAddress.parse(a);
                if (c.trim().isEmpty() && parsed.code != null) code.setText(parsed.code);
            } catch (IllegalArgumentException e) {
                say(status, e.getMessage(), BAD);
                return;
            }
            pair.setEnabled(false);
            say(status, "Pairing…", DIM);
            hub.work.execute(() -> {
                try {
                    hub.pair(a, c, n.isEmpty() ? "Quest" : n);
                    runOnUiThread(() -> {
                        AxisService.start(this);
                        hub.connect();
                        build();
                    });
                } catch (Exception e) {
                    runOnUiThread(() -> {
                        pair.setEnabled(true);
                        say(status, "Not paired: " + e.getMessage(), BAD);
                    });
                }
            });
        });
        col.addView(spacer(12));
        col.addView(pair);
        col.addView(status);
        col.addView(footer());
        return scroll(col);
    }

    // ---- main ------------------------------------------------------------------

    private View mainScreen() {
        LinearLayout col = column();
        LinearLayout head = row();
        TextView t = title("VorteX Axis");
        head.addView(t, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        pill = text("", 20, BG);
        pill.setPadding(dp(18), dp(8), dp(18), dp(8));
        pill.setTypeface(Typeface.DEFAULT_BOLD);
        head.addView(pill);
        col.addView(head);
        who = text("", 20, DIM);
        col.addView(who);

        LinearLayout pauseRow = row();
        TextView pl = text("Pause: agents are refused while paused", 22, TEXT);
        pauseRow.addView(pl, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        pause = new Switch(this);
        pause.setScaleX(1.4f);
        pause.setScaleY(1.4f);
        pause.setOnCheckedChangeListener((b, on) -> { if (on != hub.client.paused()) hub.setPaused(on); });
        pauseRow.addView(pause);
        col.addView(card(pauseRow));

        LinearLayout adbCard = column0();
        adbCard.addView(label("Headset (adb)"));
        adbState = text("", 26, TEXT);
        adbDetail = text("", 18, DIM);
        adbCard.addView(adbState);
        adbCard.addView(adbDetail);
        LinearLayout adbButtons = row();
        Button setUp = button("Set up", false);
        allow = button("Ask the headset", true);
        Button test = button("Test", false);
        adbButtons.addView(setUp);
        adbButtons.addView(allow);
        adbButtons.addView(test);
        adbCard.addView(adbButtons);
        testResult = text("", 18, DIM);
        adbCard.addView(testResult);
        LinearLayout fastRow = row();
        TextView fl = text("Faster looks: uiautomator's --compressed dump. Quicker, but it may leave out things an agent needs. Test shows both.", 18, TEXT);
        fastRow.addView(fl, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        faster = new Switch(this);
        faster.setScaleX(1.4f);
        faster.setScaleY(1.4f);
        faster.setOnCheckedChangeListener((b, on) -> { if (on != hub.fasterLooks()) hub.setFasterLooks(on); });
        fastRow.addView(faster);
        adbCard.addView(fastRow);
        help = text(SET_UP, 19, TEXT);
        help.setVisibility(View.GONE);
        adbCard.addView(help);
        setUp.setOnClickListener(v -> help.setVisibility(help.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE));
        allow.setOnClickListener(v -> hub.setUpAdb());
        test.setOnClickListener(v -> {
            say(testResult, "Reading the panel in front, normally and compressed…", DIM);
            hub.work.execute(() -> {
                String r = hub.test();
                runOnUiThread(() -> say(testResult, r, r.startsWith("Failed") ? BAD : TEXT));
            });
        });
        col.addView(card(adbCard));

        LinearLayout recentCard = column0();
        recentCard.addView(label("Recently"));
        recent = text("", 18, TEXT);
        recent.setTypeface(Typeface.MONOSPACE);
        recentCard.addView(recent);
        col.addView(card(recentCard));

        LinearLayout bottom = row();
        Button diag = button("Copy diagnostics", false);
        Button forget = button("Forget this pairing", false);
        forget.setTextColor(BAD);
        bottom.addView(diag);
        bottom.addView(forget);
        diag.setOnClickListener(v -> showDiagnostics());
        forget.setOnClickListener(v -> new AlertDialog.Builder(this)
                .setTitle("Forget this pairing?")
                .setMessage("The headset stops answering Axis. Remove it on Axis's admin page too, then pair again with a new code.")
                .setPositiveButton("Forget", (d, w) -> { hub.forget(); build(); })
                .setNegativeButton("Keep", null)
                .show());
        col.addView(bottom);
        col.addView(footer());
        return scroll(col);
    }

    static final String SET_UP =
            "Once:\n"
            + "1. Switch on developer mode for the headset in the Meta Horizon app on your phone (the headset's settings, Developer mode).\n\n"
            + "After every restart of the headset:\n"
            + "2. Connect it to a computer with a USB cable (allow USB debugging if it asks) and run:  adb tcpip 5555\n"
            + "3. Unplug the cable. Within a minute the state above says Ready, or press Ask the headset.\n\n"
            + "The first time only:\n"
            + "4. Press Ask the headset. The headset shows \"Allow USB debugging?\": tick Always allow and press Allow.\n\n"
            + "Only 2D panels (Store, Browser, Settings, Android apps) can be read and used, one at a time; never immersive apps.";

    private void render() {
        if (!showingMain) return;
        if (hub.pairing() == null) {
            build();
            return;
        }
        boolean paused = hub.client.paused();
        AxisLink.State s = hub.client.linkState();
        String word = paused ? "Paused" : linkWord(s);
        int colour = paused ? WARN : s == AxisLink.State.ONLINE ? GOOD : s == AxisLink.State.REFUSED ? BAD : s == AxisLink.State.CONNECTING ? WARN : DIM;
        pill.setText(word);
        pill.setBackground(round(colour, 12));
        AxisLink.Pairing p = hub.pairing();
        String why = s == AxisLink.State.ONLINE ? "" : hub.linkWhy.isEmpty() ? "" : "  ·  " + hub.linkWhy;
        who.setText(p.name + " at " + p.address + why);
        if (pause.isChecked() != paused) pause.setChecked(paused);
        if (faster.isChecked() != hub.fasterLooks()) faster.setChecked(hub.fasterLooks());

        AdbLink.State a = hub.client.adb.state();
        adbState.setText(adbWord(a));
        adbState.setTextColor(a == AdbLink.State.READY ? GOOD : a == AdbLink.State.NEEDS_ALLOW ? WARN : a == AdbLink.State.NOT_SET_UP ? BAD : DIM);
        adbDetail.setText(hub.client.adb.detail());
        allow.setVisibility(a == AdbLink.State.READY ? View.GONE : View.VISIBLE);

        StringBuilder sb = new StringBuilder();
        for (String line : hub.client.recent()) sb.append(line).append('\n');
        recent.setText(sb.length() == 0 ? "Nothing yet." : sb.toString().trim());
        if (s == AxisLink.State.REFUSED) who.setTextColor(BAD);
        else who.setTextColor(DIM);
    }

    static String linkWord(AxisLink.State s) {
        switch (s) {
            case ONLINE: return "Connected";
            case CONNECTING: return "Connecting";
            case REFUSED: return "Pair again";
            default: return "Offline";
        }
    }

    static String adbWord(AdbLink.State s) {
        switch (s) {
            case READY: return "Ready";
            case NEEDS_ALLOW: return "Reachable, needs Allow";
            case NOT_SET_UP: return "Not set up";
            case CONNECTING: return "Connecting…";
            default: return "Checking…";
        }
    }

    private void showDiagnostics() {
        String report = hub.diagnostics();
        TextView body = text(report, 14, TEXT);
        body.setTypeface(Typeface.MONOSPACE);
        body.setTextIsSelectable(true);
        ScrollView sv = new ScrollView(this);
        sv.setPadding(dp(16), dp(16), dp(16), dp(16));
        sv.addView(body);
        new AlertDialog.Builder(this)
                .setTitle("Diagnostics")
                .setView(sv)
                .setPositiveButton("Copy", (d, w) -> {
                    getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("VorteX Axis diagnostics", report));
                    hub.log.line("diagnostics copied");
                })
                .setNegativeButton("Close", null)
                .show();
    }

    // ---- small view helpers ----------------------------------------------------

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private static GradientDrawable round(int fill, int radiusDp, int stroke, float density) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(radiusDp * density);
        if (stroke != 0) g.setStroke(Math.round(density * 1.5f), stroke);
        return g;
    }

    private GradientDrawable round(int fill, int radiusDp) {
        return round(fill, radiusDp, 0, getResources().getDisplayMetrics().density);
    }

    private LinearLayout column() {
        LinearLayout l = column0();
        l.setPadding(dp(40), dp(32), dp(40), dp(32));
        return l;
    }

    private LinearLayout column0() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    private LinearLayout row() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        return l;
    }

    private View scroll(View v) {
        ScrollView s = new ScrollView(this);
        s.setBackgroundColor(BG);
        s.addView(v);
        return s;
    }

    private View card(View inner) {
        LinearLayout c = column0();
        c.setPadding(dp(24), dp(20), dp(24), dp(20));
        c.setBackground(round(CARD, 14, LINE, getResources().getDisplayMetrics().density));
        c.addView(inner);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(18);
        c.setLayoutParams(lp);
        return c;
    }

    private TextView text(String s, int sp, int colour) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(colour);
        t.setLineSpacing(0, 1.15f);
        t.setPadding(0, dp(4), 0, dp(4));
        return t;
    }

    private TextView title(String s) {
        TextView t = text(s, 36, TEXT);
        t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return t;
    }

    private TextView label(String s) {
        TextView t = text(s, 18, DIM);
        t.setPadding(0, dp(14), 0, dp(4));
        return t;
    }

    private EditText field(String hint, int type) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setHintTextColor(DIM);
        e.setTextColor(TEXT);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        e.setInputType(type);
        e.setSingleLine(true);
        e.setPadding(dp(18), dp(14), dp(18), dp(14));
        e.setBackground(round(CARD, 12, LINE, getResources().getDisplayMetrics().density));
        return e;
    }

    private Button button(String s, boolean primary) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        b.setTextColor(primary ? BG : TEXT);
        b.setPadding(dp(26), dp(14), dp(26), dp(14));
        b.setMinHeight(dp(64));
        b.setStateListAnimator(null);
        b.setBackground(round(primary ? ACCENT : CARD, 12, primary ? 0 : LINE, getResources().getDisplayMetrics().density));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, dp(12), dp(14), 0);
        b.setLayoutParams(lp);
        return b;
    }

    private View spacer(int h) {
        View v = new View(this);
        v.setLayoutParams(new LinearLayout.LayoutParams(1, dp(h)));
        return v;
    }

    private TextView footer() {
        TextView f = text("VorteX Axis for Quest " + BuildConfig.VERSION_NAME + " (experimental)", 16, DIM);
        f.setPadding(0, dp(28), 0, 0);
        return f;
    }

    private static void say(TextView t, String s, int colour) {
        t.setText(s);
        t.setTextColor(colour);
    }
}
