package dev.pages.kagetsu.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;

import java.io.ByteArrayInputStream;
import java.io.Closeable;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Kagetsu Tohya in a WebView, served from the APK: the same files the site publishes (index.html, css/, js/, data/),
 * the way the desktop program serves them over app://kagetsu/ (desktop/main.js). The page lives at
 * https://appassets.androidplatform.net/, a name that never reaches the network: every request to it is answered
 * here from assets/www, any other address is refused, and the WebView itself is kept off the network. The address
 * never changes, so the saves (the page's localStorage) are there at the next launch, and after an update signed
 * with the same key.
 *
 * The page knows it is in this app by the object AndroidHost (js/main.js ANDROID): it opens straight into the
 * game, sends Export here (saveFile), and leaves the whole screen and the landscape to the app.
 */
public class MainActivity extends Activity {
    static final String TAG = "KagetsuTohya";
    static final String HOST = "appassets.androidplatform.net";
    static final String HOME = "https://" + HOST + "/index.html";
    private static final int ASK_OPEN = 1, ASK_SAVE = 2;

    private static boolean checked;                      // the release check, once for the app's process
    private final ExecutorService worker = Executors.newSingleThreadExecutor();   // file writes and the release check, off the page's thread
    private WebView web;
    private boolean stopped;        // between onStop and onStart: in the background
    private ValueCallback<Uri[]> chooser;                // the page's file question (Import), until the player has answered
    private byte[] saving;                               // an exported file, until the player has said where it goes

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        w.getDecorView().setBackgroundColor(Color.BLACK);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= 30
                    ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                    : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) WebView.setWebContentsDebuggingEnabled(true);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                  // saves, settings and progress are in localStorage
        s.setMediaPlaybackRequiresUserGesture(false);  // no opening page to tap first: the music starts with the game, as on a computer
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);                            // the phone's font size must not resize the game's text
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setSupportMultipleWindows(false);            // a link that asks for a new window comes to shouldOverrideUrlLoading
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setBlockNetworkLoads(true);                  // the page fetches nothing from the network
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(false);   // (nothing but the app's own page is ever shown)
        web.setWebViewClient(new Assets(getAssets()));
        web.addJavascriptInterface(new Bridge(), "AndroidHost");
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.messageLevel() + " " + m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }

            // Settings' "Import from a file": the page's file question is the system's own document picker. Any
            // type is offered, since a .json kept in Downloads or a cloud drive is not always typed as one.
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> answer, FileChooserParams params) {
                if (chooser != null) chooser.onReceiveValue(null);
                chooser = answer;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                try { startActivityForResult(pick, ASK_OPEN); }
                catch (ActivityNotFoundException e) { chooser = null; answer.onReceiveValue(null); }
                return true;
            }
        });
        setContentView(web);
        hideBars();

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        }
        if (saved != null) web.restoreState(saved);
        if (web.getUrl() == null) web.loadUrl(HOME);

        if (!checked) {
            checked = true;
            web.postDelayed(() -> worker.execute(this::checkRelease), 4000);
        }
    }

    // ---- what the page asks of the app (js/main.js) -------------------------------------------------------------
    final class Bridge {
        /** Settings' "Export to a file": the system asks where the file is to go, and it is written there. */
        @JavascriptInterface
        public void saveFile(final String name, final String text) {
            final String file = name != null && name.matches("[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}") ? name : "kagetsu-tohya-saves.json";
            final byte[] data = (text == null ? "" : text).getBytes(StandardCharsets.UTF_8);
            runOnUiThread(() -> askWhere(file, data));
        }
    }

    private void askWhere(String file, byte[] data) {
        saving = data;
        Intent make = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/json").putExtra(Intent.EXTRA_TITLE, file);
        try { startActivityForResult(make, ASK_SAVE); }
        catch (ActivityNotFoundException e) { saving = null; Log.w(TAG, "no place to save: " + e); }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        final Uri picked = result == RESULT_OK && data != null ? data.getData() : null;
        if (request == ASK_OPEN) {
            ValueCallback<Uri[]> answer = chooser;
            chooser = null;
            if (answer != null) answer.onReceiveValue(picked != null ? new Uri[] { picked } : null);
        } else if (request == ASK_SAVE) {
            final byte[] bytes = saving;
            saving = null;
            if (bytes == null || picked == null) return;
            worker.execute(() -> {
                try (OutputStream out = getContentResolver().openOutputStream(picked, "wt")) {
                    if (out == null) throw new IOException("could not open " + picked);
                    out.write(bytes);
                } catch (Exception e) { Log.w(TAG, "export: " + e); }
            });
        }
    }

    /** A web page, in the phone's own browser. */
    private void outside(Uri u) {
        if (u == null || !("https".equals(u.getScheme()) || "http".equals(u.getScheme()))) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException e) { Log.w(TAG, "no browser for " + u); }
    }

    // ---- a newer APK ---------------------------------------------------------------------------------------------
    // A few seconds after the app opens, it asks GitHub for the latest release of the port. Where that is newer than
    // this app and carries the APK, it says so once for that version and offers the download (the phone's browser
    // fetches it; installing it over this one keeps the saves). Without a connection, or without an APK in the
    // release, nothing is said.
    static final String RELEASES = "https://api.github.com/repos/waifwu/KageTStream/releases/latest";
    static final String APK = "Kagetsu-Tohya-android.apk";

    private void checkRelease() {
        try {
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(RELEASES).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            c.setRequestProperty("Accept", "application/vnd.github+json");
            c.setRequestProperty("User-Agent", "Kagetsu-Tohya-Android");
            if (c.getResponseCode() != 200) return;
            String body;
            try (InputStream in = c.getInputStream()) {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                body = new String(out.toByteArray(), StandardCharsets.UTF_8);
            }
            org.json.JSONObject r = new org.json.JSONObject(body);
            final String latest = r.optString("tag_name", "").replaceFirst("^\\D+", "");   // desktop-v1.0.9 -> 1.0.9
            String mine = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            if (newer(latest, mine) <= 0) return;
            org.json.JSONArray assets = r.optJSONArray("assets");
            String url = null;
            for (int i = 0; assets != null && i < assets.length(); i++) {
                org.json.JSONObject a = assets.getJSONObject(i);
                if (APK.equals(a.optString("name"))) url = a.optString("browser_download_url", null);
            }
            if (url == null) return;
            final SharedPreferences prefs = getSharedPreferences("release", MODE_PRIVATE);
            if (latest.equals(prefs.getString("told", ""))) return;
            final Uri apk = Uri.parse(url);
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                prefs.edit().putString("told", latest).apply();
                new AlertDialog.Builder(this)
                        .setTitle("Kagetsu Tohya " + latest + " is out")
                        .setMessage("This is " + mine + ". The new APK installs over this one, and the saves are kept.")
                        .setPositiveButton("Download", (d, which) -> outside(apk))
                        .setNegativeButton("Not now", null)
                        .setOnDismissListener((d) -> hideBars())
                        .show();
            });
        } catch (Exception e) {
            Log.i(TAG, "release check: " + e);
        }
    }

    /** a against b as versions (1.0.10 after 1.0.9): above 0 when a is newer. */
    static int newer(String a, String b) {
        String[] x = a.split("\\."), y = b.split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? num(x[i]) : 0, q = i < y.length ? num(y[i]) : 0;
            if (p != q) return p - q;
        }
        return 0;
    }

    private static int num(String s) {
        Matcher m = Pattern.compile("^\\d+").matcher(s);
        return m.find() ? Integer.parseInt(m.group()) : 0;
    }

    // ---- the window ----------------------------------------------------------------------------------------------
    // The system Back does what the game's Esc does: the menu in the story, and back out of a page or a question
    // anywhere else. It never leaves the app, so a stray swipe does not end the reading. The key is sent where a real
    // one lands, on the page's focused element: sent to window itself, a page's own handler (shell.js onKey, which
    // stops it on its way) and the story's (input.js) would both take it, and the menu would close and open again.
    private void back() {
        if (web == null) return;
        web.evaluateJavascript("(() => { const t = document.activeElement || document.body; for (const type of ['keydown', 'keyup'])"
                + " t.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); })()", null);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() { back(); }

    @SuppressWarnings("deprecation")
    private void hideBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus) hideBars();
    }

    // Back from the background: the page's timers run again, and its sound goes on from where it stopped.
    @Override
    protected void onStart() {
        super.onStart();
        stopped = false;
        if (web != null) {
            web.resumeTimers();
            web.evaluateJavascript("globalThis.appResume && globalThis.appResume()", null);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    // Going to the background: Android may end the app from there without the page's pagehide, so what has been read
    // is written now, and the sound is stopped (main.js appSuspend). Then the page's timers stop until it comes back.
    // (The page answers a moment later. If the app is back in front by then, its timers are left running: stopped
    // after onStart had started them, they would stay stopped with the game on screen.)
    @Override
    protected void onStop() {
        stopped = true;
        web.evaluateJavascript("globalThis.appSuspend && globalThis.appSuspend()", (r) -> { if (web != null && stopped) web.pauseTimers(); });
        super.onStop();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (chooser != null) { chooser.onReceiveValue(null); chooser = null; }
        web.destroy();
        web = null;
        worker.shutdown();
        super.onDestroy();
    }

    // ---- the files -----------------------------------------------------------------------------------------------
    /** Answers the page's requests from assets/www, with byte ranges (the music player seeks). */
    final class Assets extends WebViewClient {
        private final Pattern RANGE = Pattern.compile("bytes=(\\d*)-(\\d*)");
        private final Map<String, String> TYPES = new HashMap<>();
        {
            // as desktop/main.js serves them
            String[] t = {
                "html", "text/html", "css", "text/css", "js", "text/javascript", "mjs", "text/javascript",
                "json", "application/json", "txt", "text/plain", "jpg", "image/jpeg", "jpeg", "image/jpeg",
                "png", "image/png", "bmp", "image/bmp", "gif", "image/gif", "webp", "image/webp", "ico", "image/x-icon",
                "ogg", "audio/ogg", "wav", "audio/wav", "mp3", "audio/mpeg", "ttf", "font/ttf", "otf", "font/otf",
            };
            for (int i = 0; i < t.length; i += 2) TYPES.put(t[i], t[i + 1]);
        }
        private final AssetManager assets;

        Assets(AssetManager assets) { this.assets = assets; }

        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
            if (HOST.equals(req.getUrl().getHost())) return false;
            if (req.hasGesture()) outside(req.getUrl());   // a link the player pressed (About's GitHub): in the phone's browser
            return true;                                   // no leaving the game for another site
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (!"https".equals(u.getScheme()) || !HOST.equals(u.getHost())) return status(403, "Forbidden");
            String path = u.getPath();
            if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
            // no way out of www (a ".." step, or an empty one); a name may still hold two dots (bg_17d..jpg)
            if (path.contains("//") || ("/" + path + "/").contains("/../")) return status(404, "Not Found");
            String name = "www" + path;
            String type = type(path);
            String head = header(req, "Range");
            try {
                // a stored (uncompressed) entry of the APK: it can be read from any byte
                AssetFileDescriptor fd = assets.openFd(name);
                FileInputStream in = new FileInputStream(fd.getFileDescriptor());
                long size = fd.getLength(), a = 0, b = size - 1;
                int code = 200;
                Matcher m = head == null ? null : RANGE.matcher(head.trim());
                if (m != null && m.matches() && (!m.group(1).isEmpty() || !m.group(2).isEmpty())) {
                    if (!m.group(1).isEmpty()) {
                        a = Long.parseLong(m.group(1));
                        if (!m.group(2).isEmpty()) b = Math.min(size - 1, Long.parseLong(m.group(2)));
                    } else {
                        a = Math.max(0, size - Long.parseLong(m.group(2)));
                    }
                    if (a < size && a <= b) code = 206;
                    else { a = 0; b = size - 1; }
                }
                // The WebView applies the Range itself (it skips into the stream and works out Content-Length from
                // available()), so the body starts at the file's first byte; it ends after the range's last one,
                // which the WebView would read past. The status and Content-Range say which part is sent.
                in.getChannel().position(fd.getStartOffset());
                Map<String, String> h = headers();
                h.put("Accept-Ranges", "bytes");
                if (code == 206) h.put("Content-Range", "bytes " + a + "-" + b + "/" + size);
                InputStream body = "HEAD".equals(req.getMethod()) ? empty(in, fd) : new Slice(in, b + 1, fd);
                return new WebResourceResponse(type, encoding(type), code, code == 206 ? "Partial Content" : "OK", h, body);
            } catch (FileNotFoundException e) {
                // Not stored: a compressed entry can still be read whole (no ranges), else it is missing.
                try {
                    InputStream in = assets.open(name);
                    return new WebResourceResponse(type, encoding(type), 200, "OK", headers(), in);
                } catch (IOException missing) {
                    return status(404, "Not Found");
                }
            } catch (IOException e) {
                Log.w(TAG, name + ": " + e);
                return status(500, "Internal Server Error");
            }
        }

        private InputStream empty(FileInputStream in, Closeable fd) {
            try { in.close(); fd.close(); } catch (IOException ignored) { }
            return new ByteArrayInputStream(new byte[0]);
        }

        private String header(WebResourceRequest req, String name) {
            for (Map.Entry<String, String> e : req.getRequestHeaders().entrySet()) {
                if (e.getKey().equalsIgnoreCase(name)) return e.getValue();
            }
            return null;
        }

        private Map<String, String> headers() {
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            return h;
        }

        private String type(String path) {
            int dot = path.lastIndexOf('.');
            String t = dot < 0 ? null : TYPES.get(path.substring(dot + 1).toLowerCase(Locale.ROOT));
            return t != null ? t : "application/octet-stream";
        }

        private String encoding(String type) {
            return type.startsWith("text/") || type.equals("application/json") ? "utf-8" : null;
        }

        private WebResourceResponse status(int code, String reason) {
            return new WebResourceResponse("text/plain", "utf-8", code, reason, headers(), new ByteArrayInputStream(new byte[0]));
        }
    }

    /** n bytes from where the stream stands, then the end; closing it closes the file it came from. */
    static final class Slice extends InputStream {
        private final FileInputStream in;
        private final Closeable fd;
        private long left;

        Slice(FileInputStream in, long n, Closeable fd) { this.in = in; this.left = n; this.fd = fd; }

        @Override
        public int read() throws IOException {
            if (left <= 0) return -1;
            int c = in.read();
            if (c >= 0) left--;
            return c;
        }

        @Override
        public int read(byte[] buf, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = in.read(buf, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }

        @Override
        public int available() { return (int) Math.min(Integer.MAX_VALUE, left); }

        // A seek skips to its byte at once instead of reading up to it.
        @Override
        public long skip(long n) throws IOException {
            if (n <= 0) return 0;
            long k = Math.min(n, left);
            java.nio.channels.FileChannel c = in.getChannel();
            c.position(c.position() + k);
            left -= k;
            return k;
        }

        @Override
        public void close() throws IOException {
            try { in.close(); } finally { fd.close(); }
        }
    }
}
