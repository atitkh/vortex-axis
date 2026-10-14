package dev.vortexaxis.quest;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Starts the connection again when this app has just been replaced (an update installed through the headset's
 * own adb, which ends the app's process). Android sends ACTION_MY_PACKAGE_REPLACED to the new build, and a
 * foreground service may be started from it. Nothing else runs here.
 */
public final class UpdatedReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        try {
            AxisService.start(context);
        } catch (RuntimeException e) {
            // Not allowed to start from here: the window opening starts it instead.
            Log.w("VortexAxis", "could not restart the service after an update: " + e);
        }
    }
}
