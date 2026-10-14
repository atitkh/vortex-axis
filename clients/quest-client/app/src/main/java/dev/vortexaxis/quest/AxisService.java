package dev.vortexaxis.quest;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;

import dev.vortexaxis.quest.core.AxisLink;

/**
 * Keeps the Axis link and the adb link alive while the window is not in front: a foreground
 * service with a notification that says the state and has Pause or Resume. Not started at boot
 * (phase 1): open the app once after the headset starts, which is when `adb tcpip` must be run anyway.
 */
public final class AxisService extends Service {
    static final String PAUSE = "dev.vortexaxis.quest.PAUSE", RESUME = "dev.vortexaxis.quest.RESUME";
    private static final String CHANNEL = "axis";
    private static final int ID = 1;
    private Hub hub;
    private final Runnable refresh = this::show;

    static void start(Context context) {
        context.startForegroundService(new Intent(context, AxisService.class));
    }

    @Override public void onCreate() {
        super.onCreate();
        hub = Hub.get(this);
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Connection", NotificationManager.IMPORTANCE_LOW));
        startForeground(ID, build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        hub.watch(refresh);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (PAUSE.equals(action)) hub.setPaused(true);
        else if (RESUME.equals(action)) hub.setPaused(false);
        hub.connect();
        show();
        return START_STICKY;
    }

    @Override public void onDestroy() {
        hub.unwatch(refresh);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private void show() {
        getSystemService(NotificationManager.class).notify(ID, build());
    }

    private Notification build() {
        boolean paused = hub.client.paused();
        String state = paused ? "Paused" : MainActivity.linkWord(hub.client.linkState());
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Intent toggle = new Intent(this, AxisService.class).setAction(paused ? RESUME : PAUSE);
        int f = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_note)
                .setContentTitle("VorteX Axis: " + state)
                // What it is doing now ("Tapping "Elixir"…", "Idle"), as the window's Live tab says it.
                .setContentText(hub.client.linkState() == AxisLink.State.ONLINE ? (paused ? "Agents are refused" : hub.client.doing().line()) : "Open the app for details")
                .setOngoing(true)
                .setContentIntent(PendingIntent.getActivity(this, 0, open, f))
                .addAction(new Notification.Action.Builder(null, paused ? "Resume" : "Pause", PendingIntent.getService(this, 1, toggle, f)).build())
                .build();
    }
}
