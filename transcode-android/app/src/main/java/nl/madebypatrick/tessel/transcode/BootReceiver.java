package nl.madebypatrick.tessel.transcode;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts the server after a reboot or an app update, when the user asked for that. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        if (Prefs.autoStart(ctx)) TranscodeService.start(ctx);
    }
}
