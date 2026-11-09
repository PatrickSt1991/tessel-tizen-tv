package nl.madebypatrick.tessel.transcode;

import android.content.Context;
import android.content.SharedPreferences;

final class Prefs {
    private Prefs() {}

    private static SharedPreferences p(Context ctx) {
        return ctx.getSharedPreferences("tessel", Context.MODE_PRIVATE);
    }

    /** Start the server on boot and after an update. */
    static boolean autoStart(Context ctx) {
        return p(ctx).getBoolean("autostart", false);
    }

    static void setAutoStart(Context ctx, boolean on) {
        p(ctx).edit().putBoolean("autostart", on).apply();
    }
}
