package dev.vortexaxis.quest.helper;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.SparseArray;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import dev.vortexaxis.quest.core.HelperRouter;
import dev.vortexaxis.quest.core.Json;

/** HelperRouter's Device over UiAutomation: each method one or two Android calls, no rules of its own. */
final class Screen implements HelperRouter.Device<AccessibilityNodeInfo> {
    private final UiAutomation ui;
    private boolean compressed;
    /** Accessibility events seen, for HelperRouter's wait for the screen to settle; told only when `counting`. */
    private final java.util.concurrent.atomic.AtomicLong events = new java.util.concurrent.atomic.AtomicLong();
    private volatile boolean counting;

    Screen(UiAutomation ui) {
        this.ui = ui;
        try {
            // UiAutomation's own waitForIdle keeps its own time of the last event; this listener only counts.
            ui.setOnAccessibilityEventListener(e -> events.incrementAndGet());
            counting = true;
        } catch (RuntimeException e) {
            Helper.note("no event count (" + e + "); waitForIdle instead");
        }
    }

    @Override public String[] front() {
        AccessibilityNodeInfo root = ui.getRootInActiveWindow();
        String title = "";
        for (AccessibilityWindowInfo w : ui.getWindows()) {
            if (w.isActive()) {
                title = s(w.getTitle());
                break;
            }
        }
        return new String[] {root == null ? "" : s(root.getPackageName()), title};
    }

    @Override public long generation() { return counting ? events.get() : -1; }

    @Override public void waitForIdle(int quietMs, int maxMs) {
        try {
            ui.waitForIdle(quietMs, maxMs);
        } catch (java.util.concurrent.TimeoutException ignored) {
            // Still moving: read it as it is.
        }
    }

    @Override public List<Map<String, Object>> windows() {
        List<Map<String, Object>> out = new ArrayList<>();
        SparseArray<List<AccessibilityWindowInfo>> all = new SparseArray<>();
        if (Build.VERSION.SDK_INT >= 30) all = ui.getWindowsOnAllDisplays();
        else all.put(0, ui.getWindows());
        for (int i = 0; i < all.size(); i++) {
            for (AccessibilityWindowInfo w : all.valueAt(i)) {
                Rect r = new Rect();
                w.getBoundsInScreen(r);
                AccessibilityNodeInfo root = w.getRoot();
                out.add(Json.obj("id", w.getId(), "title", w.getTitle() == null ? "" : w.getTitle().toString(),
                        "package", root == null || root.getPackageName() == null ? "" : root.getPackageName().toString(),
                        "display", all.keyAt(i), "type", w.getType(), "layer", w.getLayer(), "active", w.isActive(), "focused", w.isFocused(),
                        "bounds", java.util.Arrays.asList((Object) r.left, r.top, r.right, r.bottom)));
            }
        }
        return out;
    }

    @Override public AccessibilityNodeInfo root(Integer windowId, boolean compressed, int idleMs) {
        if (compressed != this.compressed) {
            AccessibilityServiceInfo info = ui.getServiceInfo();
            if (compressed) info.flags &= ~AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
            else info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
            ui.setServiceInfo(info);
            this.compressed = compressed;
        }
        if (idleMs > 0) {
            try {
                ui.waitForIdle(100, idleMs);
            } catch (java.util.concurrent.TimeoutException ignored) {
                // Still moving: read it as it is.
            }
        }
        if (windowId == null) return ui.getRootInActiveWindow();
        for (AccessibilityWindowInfo w : Build.VERSION.SDK_INT >= 30 ? flat(ui.getWindowsOnAllDisplays()) : ui.getWindows())
            if (w.getId() == windowId) return w.getRoot();
        return null;
    }

    private static List<AccessibilityWindowInfo> flat(SparseArray<List<AccessibilityWindowInfo>> all) {
        List<AccessibilityWindowInfo> out = new ArrayList<>();
        for (int i = 0; i < all.size(); i++) out.addAll(all.valueAt(i));
        return out;
    }

    @Override public HelperRouter.NodeData read(AccessibilityNodeInfo n) {
        HelperRouter.NodeData d = new HelperRouter.NodeData();
        d.cls = s(n.getClassName());
        d.pkg = s(n.getPackageName());
        d.text = s(n.getText());
        d.desc = s(n.getContentDescription());
        d.hint = s(n.getHintText());
        d.resId = s(n.getViewIdResourceName());
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        d.left = r.left;
        d.top = r.top;
        d.right = r.right;
        d.bottom = r.bottom;
        d.clickable = n.isClickable();
        d.longClickable = n.isLongClickable();
        d.scrollable = n.isScrollable();
        d.enabled = n.isEnabled();
        d.focused = n.isFocused();
        d.focusable = n.isFocusable();
        d.checkable = n.isCheckable();
        d.checked = n.isChecked();
        d.selected = n.isSelected();
        d.password = n.isPassword();
        d.editable = n.isEditable();
        d.visible = n.isVisibleToUser();
        d.showingHint = n.isShowingHintText();
        d.selStart = n.getTextSelectionStart();
        d.selEnd = n.getTextSelectionEnd();
        return d;
    }

    private static String s(CharSequence c) { return c == null ? "" : c.toString(); }

    @Override public int childCount(AccessibilityNodeInfo n) { return n.getChildCount(); }
    @Override public AccessibilityNodeInfo child(AccessibilityNodeInfo n, int i) { return n.getChild(i); }
    @Override public boolean refresh(AccessibilityNodeInfo n) { return n.refresh(); }
    @Override public boolean click(AccessibilityNodeInfo n) { return n.performAction(AccessibilityNodeInfo.ACTION_CLICK); }
    @Override public boolean longClick(AccessibilityNodeInfo n) { return n.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK); }
    @Override public boolean focus(AccessibilityNodeInfo n) { return n.performAction(AccessibilityNodeInfo.ACTION_FOCUS); }

    @Override public boolean setText(AccessibilityNodeInfo n, String text, int caret) {
        Bundle a = new Bundle();
        a.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        if (!n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, a)) return false;
        Bundle at = new Bundle();
        at.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, caret);
        at.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, caret);
        n.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, at);
        return true;
    }

    @Override public boolean scroll(AccessibilityNodeInfo n, boolean forward) {
        return n.performAction(forward ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD);
    }

    @Override public AccessibilityNodeInfo focusedInput() {
        AccessibilityNodeInfo root = ui.getRootInActiveWindow();
        return root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
    }

    @Override public void tap(int x, int y) throws Exception {
        long t = SystemClock.uptimeMillis();
        touch(MotionEvent.ACTION_DOWN, t, t, x, y);
        touch(MotionEvent.ACTION_UP, t, t + 60, x, y);
    }

    @Override public void longPress(int x, int y) throws Exception {
        long t = SystemClock.uptimeMillis();
        touch(MotionEvent.ACTION_DOWN, t, t, x, y);
        Thread.sleep(800);
        touch(MotionEvent.ACTION_UP, t, SystemClock.uptimeMillis(), x, y);
    }

    @Override public void swipe(int x1, int y1, int x2, int y2, int ms) throws Exception {
        long t = SystemClock.uptimeMillis();
        touch(MotionEvent.ACTION_DOWN, t, t, x1, y1);
        int steps = Math.max(2, ms / 10);
        for (int i = 1; i <= steps; i++) {
            Thread.sleep(Math.max(1, ms / steps));
            touch(MotionEvent.ACTION_MOVE, t, SystemClock.uptimeMillis(), x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
        }
        touch(MotionEvent.ACTION_UP, t, SystemClock.uptimeMillis(), x2, y2);
    }

    private void touch(int action, long down, long at, int x, int y) {
        MotionEvent e = MotionEvent.obtain(down, at, action, x, y, 0);
        e.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        try {
            if (!ui.injectInputEvent(e, true)) throw new IllegalStateException("the touch was not taken");
        } finally {
            e.recycle();
        }
    }

    @Override public void key(int code, boolean ctrl, boolean alt, boolean shift) {
        int meta = (ctrl ? KeyEvent.META_CTRL_ON | KeyEvent.META_CTRL_LEFT_ON : 0) | (alt ? KeyEvent.META_ALT_ON | KeyEvent.META_ALT_LEFT_ON : 0)
                | (shift ? KeyEvent.META_SHIFT_ON | KeyEvent.META_SHIFT_LEFT_ON : 0);
        long t = SystemClock.uptimeMillis();
        for (int action : new int[] {KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP}) {
            KeyEvent k = new KeyEvent(t, SystemClock.uptimeMillis(), action, code, 0, meta, -1, 0, 0, InputDevice.SOURCE_KEYBOARD);
            if (!ui.injectInputEvent(k, true)) throw new IllegalStateException("the key was not taken");
        }
    }

    @Override public void back() {
        if (!ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)) throw new IllegalStateException("Back was not taken");
    }

    @Override public Object[] screenshot(int maxSide, int[] crop) {
        Bitmap full = ui.takeScreenshot();
        if (full == null) return null;
        Bitmap img = full;
        if (crop != null) {
            int x = Math.min(Math.max(0, crop[0]), full.getWidth() - 1), y = Math.min(Math.max(0, crop[1]), full.getHeight() - 1);
            img = Bitmap.createBitmap(full, x, y, Math.max(1, Math.min(crop[2], full.getWidth() - x)), Math.max(1, Math.min(crop[3], full.getHeight() - y)));
        }
        double scale = Math.min(1.0, (double) maxSide / Math.max(img.getWidth(), img.getHeight()));
        int w = Math.max(1, (int) Math.round(img.getWidth() * scale)), h = Math.max(1, (int) Math.round(img.getHeight() * scale));
        Bitmap out = scale < 1.0 ? Bitmap.createScaledBitmap(img, w, h, true) : img;
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        out.compress(Bitmap.CompressFormat.JPEG, 80, b);
        return new Object[] {b.toByteArray(), out.getWidth(), out.getHeight()};
    }
}
