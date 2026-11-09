package nl.madebypatrick.tessel.transcode;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

/**
 * One screen: whether the server runs, the address the TV should use, a
 * start/stop button, and below that the server's own setup page (the same one
 * a desktop browser shows on port 8200), so the share is configured right here
 * on the phone.
 */
public class MainActivity extends Activity {

    private static final String SETUP_URL = "http://127.0.0.1:" + TranscodeService.PORT + "/";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextView status, address, error;
    private Button toggle, battery;
    private WebView web;
    private TranscodeService.State shown;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            refresh();
            ui.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_main);

        View root = findViewById(R.id.root);
        // targetSdk 35 draws edge to edge; keep the content clear of the bars.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            @SuppressWarnings("deprecation")
            int l = insets.getSystemWindowInsetLeft(), t = insets.getSystemWindowInsetTop(),
                    r = insets.getSystemWindowInsetRight(), b = insets.getSystemWindowInsetBottom();
            v.setPadding(l, t, r, b);
            return insets;
        });

        status = findViewById(R.id.status);
        address = findViewById(R.id.address);
        error = findViewById(R.id.error);
        toggle = findViewById(R.id.toggle);
        battery = findViewById(R.id.battery);
        web = findViewById(R.id.web);

        toggle.setOnClickListener(v -> {
            if (TranscodeService.state() == TranscodeService.State.STOPPED) {
                TranscodeService.start(this);
            } else {
                TranscodeService.stop(this);
            }
            ui.postDelayed(this::refresh, 200);
        });

        findViewById(R.id.log).setOnClickListener(v -> showLog());

        Switch auto = findViewById(R.id.autostart);
        auto.setChecked(Prefs.autoStart(this));
        auto.setOnCheckedChangeListener((b, on) -> Prefs.setAutoStart(this, on));

        battery.setOnClickListener(v -> {
            try {
                startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + getPackageName())));
            } catch (Exception e) {
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            }
        });

        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient()); // alert()/confirm() on the setup page

        // Without this the foreground-service notification (and its Stop
        // button) stays hidden on Android 13+.
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }

        // Opening the app is the moment someone wants the server, so start it.
        if (saved == null && TranscodeService.state() == TranscodeService.State.STOPPED) {
            TranscodeService.start(this);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        shown = null;
        ui.post(tick);
    }

    @Override
    protected void onPause() {
        ui.removeCallbacks(tick);
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (web.getVisibility() == View.VISIBLE && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private void refresh() {
        TranscodeService.State s = TranscodeService.state();
        switch (s) {
            case RUNNING:
                status.setText(R.string.state_running);
                break;
            case STARTING:
                status.setText(R.string.state_starting);
                break;
            case FAILED:
                status.setText(R.string.state_failed);
                break;
            default:
                status.setText(R.string.state_stopped);
        }
        toggle.setText(s == TranscodeService.State.STOPPED ? R.string.start : R.string.stop);
        address.setText(getString(R.string.address, Net.serverUrl(this)));

        String err = TranscodeService.lastError();
        boolean showErr = s == TranscodeService.State.FAILED && !err.isEmpty();
        error.setVisibility(showErr ? View.VISIBLE : View.GONE);
        if (showErr) error.setText(err);

        PowerManager pm = getSystemService(PowerManager.class);
        battery.setVisibility(pm.isIgnoringBatteryOptimizations(getPackageName()) ? View.GONE : View.VISIBLE);

        // Load the setup page once when the server comes up; leave it alone
        // while it stays up so typing in it isn't interrupted.
        if (s != shown) {
            if (s == TranscodeService.State.RUNNING) {
                web.setVisibility(View.VISIBLE);
                web.loadUrl(SETUP_URL);
            } else if (s == TranscodeService.State.STOPPED) {
                web.setVisibility(View.GONE);
                web.loadUrl("about:blank");
            }
            shown = s;
        }
    }

    private void showLog() {
        String text = TranscodeService.logText();
        if (text.isEmpty()) text = getString(R.string.log_empty);
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextIsSelectable(true);
        tv.setTypeface(android.graphics.Typeface.MONOSPACE);
        tv.setTextSize(11);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        tv.setPadding(pad, pad, pad, pad);
        ScrollView sv = new ScrollView(this);
        sv.addView(tv);
        sv.post(() -> sv.fullScroll(View.FOCUS_DOWN));
        final String copy = text;
        new AlertDialog.Builder(this)
                .setTitle(R.string.show_log)
                .setView(sv)
                .setPositiveButton(R.string.close, null)
                .setNeutralButton(R.string.copy, (d, w) -> {
                    ClipboardManager cm = getSystemService(ClipboardManager.class);
                    cm.setPrimaryClip(ClipData.newPlainText("Tessel log", copy));
                })
                .show();
    }
}
