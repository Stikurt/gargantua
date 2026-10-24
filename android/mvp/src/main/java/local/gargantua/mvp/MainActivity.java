package local.gargantua.mvp;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.ActivityNotFoundException;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JsPromptResult;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/** The search/offline MVP is isolated from the legacy audiobook application. */
public final class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String ORIGIN = "https://" + HOST;
    private static final String CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
    private final ExecutorService tasks = Executors.newFixedThreadPool(3);
    private WebView web;
    private volatile String server = "";
    private volatile boolean offline = false;
    private volatile String testSession = "";
    private final AtomicLong requestIds = new AtomicLong();
    private boolean closing = false;
    private AlertDialog configDialog;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        try {
            String savedServer = getPreferences(0).getString("server", "");
            server = savedServer.isEmpty() ? "" : ServerAddress.validate(savedServer);
            offline = BuildConfig.DEBUG && getPreferences(0).getBoolean("debug-offline", false);
            if (BuildConfig.DEBUG) testSession = getPreferences(0).getString("debug-test-session", "");
            applyDebugIntent(getIntent());
        } catch (Exception ignored) { server = ""; offline = false; }
        web = new WebView(this);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(17, 21, 27));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                FrameLayout.LayoutParams layout = (FrameLayout.LayoutParams) web.getLayoutParams();
                if (layout.leftMargin != bars.left || layout.topMargin != bars.top || layout.rightMargin != bars.right || layout.bottomMargin != bars.bottom) {
                    layout.setMargins(bars.left, bars.top, bars.right, bars.bottom);
                    web.setLayoutParams(layout);
                }
                return WindowInsets.CONSUMED;
            });
            root.requestApplyInsets();
        }
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        CookieManager.getInstance().setAcceptCookie(false);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            TextView failure = new TextView(this);
            failure.setText("Обновите Android System WebView в магазине приложений, затем откройте Гаргантюа снова.");
            failure.setPadding(32, 64, 32, 32); setContentView(failure); return;
        }
        WebViewCompat.addWebMessageListener(web, "GargantuaAndroid", Collections.singleton(ORIGIN), (view, message, source, isMainFrame, reply) -> {
            if (!isMainFrame || !ORIGIN.equals(source.toString())) return;
            String raw = message.getData();
            if (raw == null || raw.length() > 16384) return;
            try {
                JSONObject request = new JSONObject(raw);
                long id = request.getLong("id");
                String method = request.getString("method");
                switch (method) {
                    case "getServer": respond(reply, id, serverInfo()); break;
                    case "configureServer": configure(reply, id); break;
                    case "closeReady":
                        respond(reply, id, true);
                        if (closing) {
                            if (request.optBoolean("flushFailed")) {
                                closing = false;
                                Toast.makeText(this, "Не удалось сохранить место чтения. Повторите закрытие.", Toast.LENGTH_LONG).show();
                            } else finish();
                        }
                        break;
                    case "request":
                        String path = request.optString("path", "");
                        tasks.execute(() -> {
                            long requestId = requestIds.incrementAndGet();
                            boolean requestOffline = offline;
                            String requestServer = server, requestSession = testSession;
                            audit("mvp-request-start", requestId, path, requestOffline, requestSession, null);
                            JSONObject result = MvpTransport.request(requestServer, path, requestOffline);
                            audit("mvp-request", requestId, path, requestOffline, requestSession, result);
                            runOnUiThread(() -> respond(reply, id, result));
                        });
                        break;
                    default: respond(reply, id, MvpTransport.error("Неизвестная операция.", 400, "REQUEST_INVALID"));
                }
            } catch (Exception ignored) { }
        });
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder().addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request.isForMainFrame() && request.hasGesture()) {
                    String external = ExternalSourceLink.validate(request.getUrl().toString());
                    if (external != null) {
                        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(external)).addCategory(Intent.CATEGORY_BROWSABLE)); }
                        catch (ActivityNotFoundException | SecurityException unavailable) {
                            Toast.makeText(MainActivity.this, "Не удалось открыть ссылку. Установите или включите браузер.", Toast.LENGTH_LONG).show();
                        }
                    }
                }
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!"GET".equals(request.getMethod()) || !"https".equals(uri.getScheme()) || !HOST.equals(uri.getHost()) || uri.getPort() != -1) return blocked();
                try {
                    if ("/".equals(uri.getPath()) || "/index.html".equals(uri.getPath())) {
                        try (InputStream input = getAssets().open("index.html")) {
                            ByteArrayOutputStream output = new ByteArrayOutputStream();
                            byte[] buffer = new byte[16384]; int count;
                            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                            String html = new String(output.toByteArray(), StandardCharsets.UTF_8);
                            html = html.replaceFirst("<head>", "<head><script src=\"/native-bridge.js\"></script>");
                            return new WebResourceResponse("text/html", "UTF-8", 200, "OK", headers(), new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
                        }
                    }
                    WebResourceResponse asset = loader.shouldInterceptRequest(uri);
                    if (asset == null) return blocked();
                    asset.setResponseHeaders(headers());
                    return asset;
                } catch (Exception ignored) { return blocked(); }
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
                if (!url.startsWith(ORIGIN + "/")) { result.cancel(); return true; }
                EditText input = new EditText(MainActivity.this);
                input.setText(defaultValue); input.setSingleLine(true);
                new AlertDialog.Builder(MainActivity.this).setTitle(message).setView(input)
                    .setPositiveButton("Сохранить", (dialog, which) -> result.confirm(input.getText().toString()))
                    .setNegativeButton("Отмена", (dialog, which) -> result.cancel()).setOnCancelListener(dialog -> result.cancel()).show();
                return true;
            }
        });
        web.loadUrl(ORIGIN + "/");
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
        if (BuildConfig.DEBUG) {
            try { applyDebugIntent(intent); } catch (Exception ignored) { }
            if (web != null) web.evaluateJavascript("window.dispatchEvent(new CustomEvent('gargantua-server-changed'))", null);
        }
    }

    private void applyDebugIntent(Intent intent) {
        if (!BuildConfig.DEBUG || intent == null) return;
        if (intent.hasExtra("gargantua.orientation")) {
            String value = intent.getStringExtra("gargantua.orientation");
            if ("portrait".equals(value)) setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            else if ("landscape".equals(value)) setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
            else if ("auto".equals(value)) setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
        if (intent.hasExtra("gargantua.server")) {
            server = ServerAddress.validate(intent.getStringExtra("gargantua.server"));
            getPreferences(0).edit().putString("server", server).commit();
        }
        if (intent.hasExtra("gargantua.offline")) {
            offline = intent.getBooleanExtra("gargantua.offline", false);
            getPreferences(0).edit().putBoolean("debug-offline", offline).commit();
        }
        if (intent.hasExtra("gargantua.testSession")) {
            String value = intent.getStringExtra("gargantua.testSession");
            if (value != null && value.matches("[A-Za-z0-9_.-]{1,120}")) {
                testSession = value;
                getPreferences(0).edit().putString("debug-test-session", testSession).commit();
            }
        }
    }

    private void audit(String event, long id, String path, boolean requestOffline, String session, JSONObject result) {
        if (!BuildConfig.DEBUG) return;
        try {
            JSONObject entry = new JSONObject().put("event", event).put("requestId", id).put("path", path).put("offline", requestOffline).put("session", session).put("at", System.currentTimeMillis());
            if (result != null) entry.put("status", result.optInt("status", 200)).put("code", result.optString("code", ""));
            Log.i("GargantuaMvp", entry.toString());
        } catch (Exception ignored) { }
    }

    private JSONObject serverInfo() {
        JSONObject info = new JSONObject();
        try { info.put("server", server).put("configured", !server.isEmpty()).put("offline", offline); } catch (Exception ignored) { }
        return info;
    }

    private void respond(JavaScriptReplyProxy reply, long id, Object value) {
        if (isDestroyed()) return;
        try { reply.postMessage(new JSONObject().put("id", id).put("value", value).toString()); } catch (Exception ignored) { }
    }

    private void configure(JavaScriptReplyProxy reply, long id) {
        if (configDialog != null && configDialog.isShowing()) { respond(reply, id, serverInfo()); return; }
        EditText input = new EditText(this);
        input.setSingleLine(true); input.setText(server); input.setHint("http://192.168.1.10:3080");
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        int pad = Math.round(20 * getResources().getDisplayMetrics().density);
        FrameLayout frame = new FrameLayout(this); frame.setPadding(pad, 0, pad, 0); frame.addView(input);
        configDialog = new AlertDialog.Builder(this).setTitle("Сервер Гаргантюа")
            .setMessage("Укажите адрес ПК, на котором запущен сервер. В одной Wi-Fi-сети: http://адрес-ПК:3080. Через Tailscale используйте HTTPS-адрес. Скачанные главы читаются без подключения.")
            .setView(frame).setNegativeButton("Отмена", (dialog, which) -> respond(reply, id, serverInfo()))
            .setPositiveButton("Подключить", null).setOnCancelListener(dialog -> respond(reply, id, serverInfo())).create();
        configDialog.setOnShowListener(dialog -> {
            configDialog.getButton(AlertDialog.BUTTON_POSITIVE).setMinHeight(Math.round(48 * getResources().getDisplayMetrics().density));
            configDialog.getButton(AlertDialog.BUTTON_NEGATIVE).setMinHeight(Math.round(48 * getResources().getDisplayMetrics().density));
            configDialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                try {
                    String next = ServerAddress.validate(input.getText().toString());
                    if (!getPreferences(0).edit().putString("server", next).putBoolean("debug-offline", false).commit()) throw new IllegalStateException();
                    server = next; offline = false;
                    configDialog.dismiss(); respond(reply, id, serverInfo());
                    web.evaluateJavascript("window.dispatchEvent(new CustomEvent('gargantua-server-changed'))", null);
                } catch (IllegalArgumentException error) { input.setError(error.getMessage()); }
                catch (Exception error) { input.setError("Не удалось сохранить настройки. Повторите попытку."); }
            });
        });
        configDialog.show();
    }

    private static Map<String, String> headers() {
        Map<String, String> values = new HashMap<>();
        values.put("Content-Security-Policy", CSP); values.put("X-Content-Type-Options", "nosniff");
        values.put("Cache-Control", "no-store"); return values;
    }

    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", headers(), new ByteArrayInputStream(new byte[0]));
    }

    @Override protected void onPause() {
        if (web != null) web.evaluateJavascript("window.__gargantuaLifecycle?.('gargantua-background')", null);
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        if (web != null) web.evaluateJavascript("window.__gargantuaLifecycle?.('gargantua-resume')", null);
    }

    @Override public void onBackPressed() {
        if (closing || web == null) return;
        web.evaluateJavascript("Boolean(window.__gargantuaBack?.())", handled -> {
            if ("true".equals(handled) || isFinishing()) return;
            closing = true;
            web.evaluateJavascript("typeof window.__gargantuaClose === 'function'", ready -> {
                if (!"true".equals(ready)) { finish(); return; }
                web.evaluateJavascript("window.__gargantuaClose()", null);
            });
        });
    }

    @Override protected void onDestroy() {
        if (configDialog != null) configDialog.dismiss();
        tasks.shutdownNow();
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
        super.onDestroy();
    }
}
