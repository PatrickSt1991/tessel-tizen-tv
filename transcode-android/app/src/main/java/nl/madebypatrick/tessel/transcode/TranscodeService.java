package nl.madebypatrick.tessel.transcode;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Runs the Go transcode server (shipped as libtessel.so) as a child process and
 * keeps the phone awake enough to serve it: a foreground service so Android
 * leaves it alone, a partial wake lock so the CPU keeps encoding with the
 * screen off, and a Wi-Fi lock so the radio doesn't doze between requests.
 *
 * The server is the exact same code as the Docker image and the desktop
 * builds; this class only starts it, restarts it when it dies, and collects its
 * log for the in-app viewer.
 */
public class TranscodeService extends Service {

    static final String ACTION_STOP = "nl.madebypatrick.tessel.transcode.STOP";
    static final int PORT = 8200;

    private static final String CHANNEL = "server";
    private static final int NOTIFICATION_ID = 1;
    private static final int LOG_LINES = 400;

    /** What the activity shows. Only this service writes it. */
    enum State { STOPPED, STARTING, RUNNING, FAILED }

    private static volatile State state = State.STOPPED;
    private static volatile String lastError = "";
    private static final ArrayDeque<String> log = new ArrayDeque<>();

    static State state() { return state; }
    static String lastError() { return lastError; }

    static String logText() {
        synchronized (log) {
            return String.join("\n", log);
        }
    }

    private static void addLog(String line) {
        synchronized (log) {
            if (log.size() >= LOG_LINES) log.removeFirst();
            log.addLast(line);
        }
    }

    static void start(Context ctx) {
        ctx.startForegroundService(new Intent(ctx, TranscodeService.class));
    }

    static void stop(Context ctx) {
        ctx.startService(new Intent(ctx, TranscodeService.class).setAction(ACTION_STOP));
    }

    private volatile boolean stopping;
    private volatile Process process;
    private Thread runner;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            // startForegroundService() promises a startForeground(); keep that
            // promise even on the way out, or Android crashes the app.
            goForeground(getString(R.string.notif_stopping));
            stopSelf();
            return START_NOT_STICKY;
        }
        goForeground(getString(R.string.notif_starting));
        if (runner == null) {
            stopping = false;
            acquireLocks();
            runner = new Thread(this::runLoop, "tessel-server");
            runner.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopping = true;
        Process p = process;
        if (p != null) p.destroy();
        if (runner != null) runner.interrupt();
        runner = null;
        releaseLocks();
        state = State.STOPPED;
        addLog("-- stopped");
        super.onDestroy();
    }

    // ── the child process ───────────────────────────────────────────────────

    /** Start the server, wait for it, and start it again if it dies. */
    private void runLoop() {
        long backoff = 2000;
        while (!stopping) {
            long started = System.currentTimeMillis();
            state = State.STARTING;
            try {
                runOnce();
            } catch (Exception e) {
                lastError = String.valueOf(e.getMessage());
                addLog("-- " + lastError);
            }
            if (stopping) break;
            state = State.FAILED;
            updateNotification(getString(R.string.notif_restarting));
            // A server that ran for a while and then fell over gets a quick
            // retry; one that keeps dying at startup backs off.
            if (System.currentTimeMillis() - started > 60_000) backoff = 2000;
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                break;
            }
            backoff = Math.min(backoff * 2, 60_000);
        }
    }

    private void runOnce() throws Exception {
        String libDir = getApplicationInfo().nativeLibraryDir;
        File server = new File(libDir, "libtessel.so");
        if (!server.exists()) {
            throw new IllegalStateException("libtessel.so missing from " + libDir);
        }
        File work = new File(getCacheDir(), "hls");
        //noinspection ResultOfMethodCallIgnored
        work.mkdirs();

        List<String> cmd = new ArrayList<>();
        cmd.add(server.getAbsolutePath());
        ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(true);
        Map<String, String> env = pb.environment();
        env.put("PORT", String.valueOf(PORT));
        env.put("DATA_DIR", getFilesDir().getAbsolutePath());
        env.put("WORK_DIR", work.getAbsolutePath());
        env.put("TMPDIR", getCacheDir().getAbsolutePath());
        env.put("FFMPEG", new File(libDir, "libffmpeg.so").getAbsolutePath());
        env.put("FFPROBE", new File(libDir, "libffprobe.so").getAbsolutePath());
        env.put("TESSEL_NAME", deviceName());
        env.put("TESSEL_EXIT_WITH_PARENT", "1");

        addLog("-- starting server");
        Process p = pb.start();
        process = p;
        String last = "";
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
            String line;
            while ((line = r.readLine()) != null) {
                addLog(line);
                last = line;
                if (line.contains("listening on")) {
                    state = State.RUNNING;
                    lastError = "";
                    updateNotification(getString(R.string.notif_running, Net.serverUrl(this)));
                }
            }
        } finally {
            int code = p.waitFor();
            process = null;
            if (!stopping) {
                // The server log.Fatal()s with the reason as its last line
                // (port taken, ffmpeg missing, unreadable config).
                lastError = last.isEmpty() ? "exit code " + code : last;
                addLog("-- server exited with code " + code);
            }
        }
    }

    static String deviceName() {
        String m = Build.MODEL == null ? "" : Build.MODEL.trim();
        String brand = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        if (!brand.isEmpty() && !m.toLowerCase().startsWith(brand.toLowerCase())) {
            m = Character.toUpperCase(brand.charAt(0)) + brand.substring(1) + " " + m;
        }
        return m.isEmpty() ? "Tessel on Android" : m;
    }

    // ── locks ───────────────────────────────────────────────────────────────

    private void acquireLocks() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tessel:server");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();

        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        @SuppressWarnings("deprecation")
        int mode = WifiManager.WIFI_MODE_FULL_HIGH_PERF;
        wifiLock = wm.createWifiLock(mode, "tessel:server");
        wifiLock.setReferenceCounted(false);
        wifiLock.acquire();
    }

    private void releaseLocks() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        wakeLock = null;
        wifiLock = null;
    }

    // ── notification ────────────────────────────────────────────────────────

    private void goForeground(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL,
                    getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        Notification n = buildNotification(text);
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    private void updateNotification(String text) {
        if (stopping) return;
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, buildNotification(text));
    }

    private Notification buildNotification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, TranscodeService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setShowWhen(false)
                .addAction(new Notification.Action.Builder(null, getString(R.string.stop), stop).build())
                .build();
    }
}
