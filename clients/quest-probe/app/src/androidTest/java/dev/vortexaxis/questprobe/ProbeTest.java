package dev.vortexaxis.questprobe;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.UiDevice;

import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

// Q2: what an instrumentation process can see, and whether it outlives the cable and sleep.
// Extras: seconds (default 120), swipe=true for one harmless swipe at the display centre.
public class ProbeTest {
    @Test
    public void probe() throws Exception {
        Instrumentation inst = InstrumentationRegistry.getInstrumentation();
        Bundle args = InstrumentationRegistry.getArguments();
        int seconds = Integer.parseInt(args.getString("seconds", "120"));
        boolean swipe = "true".equals(args.getString("swipe"));

        File dir = inst.getTargetContext().getExternalFilesDir(null);
        File log = new File(dir, "q2.log");
        UiDevice device = UiDevice.getInstance(inst);
        UiAutomation ua = inst.getUiAutomation();
        AccessibilityServiceInfo info = ua.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        ua.setServiceInfo(info);

        write(log, "start seconds=" + seconds + " swipe=" + swipe + " dir=" + dir);
        try (FileOutputStream f = new FileOutputStream(new File(dir, "q2-dump.xml"))) {
            device.dumpWindowHierarchy(f);
        }
        write(log, windows(ua));

        if (swipe) {
            int cx = device.getDisplayWidth() / 2, cy = device.getDisplayHeight() / 2;
            boolean ok = device.swipe(cx, cy + 100, cx, cy - 100, 20);
            write(log, "swipe " + cx + "," + cy + " returned " + ok);
        }

        long end = System.currentTimeMillis() + seconds * 1000L;
        while (System.currentTimeMillis() < end) {
            String line;
            try {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                device.dumpWindowHierarchy(b);
                line = "heartbeat nodes=" + count(b.toString("UTF-8"), "<node ");
            } catch (Exception e) {
                line = "heartbeat dump failed: " + e;
            }
            write(log, line);
            Thread.sleep(5000);
        }
        write(log, "done");
    }

    static String windows(UiAutomation ua) {
        List<AccessibilityWindowInfo> ws = ua.getWindows();
        StringBuilder s = new StringBuilder("windows count=" + ws.size());
        Rect r = new Rect();
        for (AccessibilityWindowInfo w : ws) {
            w.getBoundsInScreen(r);
            AccessibilityNodeInfo root = w.getRoot();
            CharSequence pkg = root != null ? root.getPackageName() : null;
            s.append("\n  id=").append(w.getId()).append(" display=").append(w.getDisplayId())
                    .append(" type=").append(w.getType()).append(" pkg=").append(pkg)
                    .append(" title=").append(w.getTitle()).append(" bounds=").append(r.toShortString())
                    .append(" active=").append(w.isActive()).append(" focused=").append(w.isFocused());
        }
        return s.toString();
    }

    static int count(String s, String what) {
        int n = 0;
        for (int i = s.indexOf(what); i >= 0; i = s.indexOf(what, i + 1)) n++;
        return n;
    }

    static void write(File log, String line) throws IOException {
        String stamped = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date()) + " " + line;
        try (FileWriter w = new FileWriter(log, true)) {
            w.write(stamped + "\n");
        }
        System.out.println(stamped);
    }
}
