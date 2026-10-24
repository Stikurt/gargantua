package local.gargantua.mvp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.AtomicFile;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** Foreground dataSync work is independent of the Activity and WebView lifetime. */
public final class DownloadService extends Service {
    static final String CHANGED = "local.gargantua.mvp.DOWNLOADS_CHANGED";
    private static final String CHANNEL = "gargantua_downloads", PAUSE = "local.gargantua.mvp.DOWNLOAD_PAUSE";
    private static final int NOTIFICATION = 301;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final DownloadControl CONTROL = new DownloadControl(Executors.newSingleThreadExecutor(), action -> MAIN.post(action));
    private static volatile DownloadService running;
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private final DownloadPacing recovery = new DownloadPacing();
    private ScheduledFuture<?> scheduled;
    private volatile boolean stopping;
    private volatile String currentId;
    private volatile MvpTransport.RequestControl currentRequest;
    private PowerManager.WakeLock wakeLock;
    private long wakeRenewedAt;
    private DownloadStore store;

    static void startIfNeeded(Context context, BooleanSupplier visible, Consumer<RuntimeException> complete) {
        Context app = context.getApplicationContext();
        CONTROL.requestStart(() -> DownloadStore.get(app).active(), visible, () -> {
            DownloadService current = running;
            if (current != null && !current.stopping) current.schedule(0);
            else app.startForegroundService(new Intent(app, DownloadService.class));
        }, () -> changed(app), complete);
    }
    static void signal(Context context) {
        Context app = context.getApplicationContext();
        CONTROL.execute(() -> signalOnWorker(app));
    }
    private static void signalOnWorker(Context context) {
        DownloadService current = running;
        if (current != null && !current.stopping) {
            if (current.currentId != null) {
                try { JSONObject job = DownloadStore.get(context).summary(current.currentId); if (job == null || !DownloadProtocol.runnable(job.optString("status"))) { MvpTransport.RequestControl request = current.currentRequest; if (request != null) request.cancel(); } } catch (Exception ignored) { }
            }
            current.schedule(0);
        }
        snapshot(context);
    }
    static void changed(Context context) {
        Context app = context.getApplicationContext();
        CONTROL.execute(() -> snapshot(app));
    }
    private static void snapshot(Context context) {
        try {
            JSONArray jobs = DownloadStore.get(context).list();
            JSONObject snapshot = new JSONObject().put("schemaVersion", 1).put("updatedAt", System.currentTimeMillis()).put("serviceRunning", running != null && !running.stopping).put("session", MvpConnection.session(context)).put("jobs", jobs);
            AtomicFile file = new AtomicFile(new File(context.getFilesDir(), "download-progress.json"));
            FileOutputStream output = null;
            synchronized (DownloadService.class) {
                try { output = file.startWrite(); output.write(snapshot.toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(output); }
                catch (Exception error) { if (output != null) file.failWrite(output); }
            }
            if (BuildConfig.DEBUG) {
                for (int i = 0; i < jobs.length(); i++) { JSONObject job = jobs.getJSONObject(i); Log.i("GargantuaDownloads", new JSONObject().put("event", "download-progress").put("id", job.getString("id")).put("downloaded", job.getInt("downloaded")).put("total", job.getInt("total")).put("status", job.getString("status")).put("session", MvpConnection.session(context)).put("at", System.currentTimeMillis()).toString()); }
            }
            context.sendBroadcast(new Intent(CHANGED).setPackage(context.getPackageName()));
        } catch (Exception ignored) { }
    }
    @Override public void onCreate() {
        super.onCreate(); running = this; store = DownloadStore.get(this);
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Скачивание книг", NotificationManager.IMPORTANCE_LOW); channel.setDescription("Сохранение глав для чтения без интернета"); channel.setSound(null, null);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
        wakeLock = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":downloads"); wakeLock.setReferenceCounted(false);
        startForeground(NOTIFICATION, notification(null), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && PAUSE.equals(intent.getAction())) {
            String id = intent.getStringExtra("id");
            CONTROL.execute(() -> {
                try { store.pause(id); } catch (Exception ignored) { }
                MvpTransport.RequestControl request = currentRequest; if (request != null) request.cancel();
                schedule(0);
            });
        } else schedule(0);
        return START_NOT_STICKY; // Persisted work resumes on an explicit new opening, never boot/force-stop bypass.
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    private Notification notification(JSONObject job) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 301, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.app_icon).setContentTitle("Гаргантюа — скачивание").setContentIntent(content).setOnlyAlertOnce(true).setOngoing(true).setCategory(Notification.CATEGORY_PROGRESS);
        if (job == null) return builder.setContentText("Подготовка сохранённых загрузок…").setProgress(0, 0, true).build();
        String title = job.optString("title", "Книга");
        builder.setContentTitle(title.length() > 100 ? title.substring(0, 100) : title).setContentText(job.optInt("downloaded") + " из " + job.optInt("total") + (job.optString("status").equals("waiting") ? " · ожидание подключения или источника" : " · сохраняем на телефоне")).setProgress(job.optInt("total"), job.optInt("downloaded"), false);
        PendingIntent pause = PendingIntent.getService(this, job.optString("id").hashCode(), new Intent(this, DownloadService.class).setAction(PAUSE).putExtra("id", job.optString("id")), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        builder.addAction(new Notification.Action.Builder(null, "Пауза", pause).build());
        return builder.build();
    }
    private synchronized void schedule(long delay) {
        if (stopping || worker.isShutdown()) return;
        if (scheduled != null && !scheduled.isDone()) scheduled.cancel(false);
        scheduled = worker.schedule(this::tick, delay, TimeUnit.MILLISECONDS);
    }
    private void tick() {
        if (stopping) return;
        long delay = 300;
        try {
            if (!store.active()) { finishService(); return; }
            String id = store.nextJob(System.currentTimeMillis());
            if (id == null) {
                JSONArray jobs = store.list(); for (int i = 0; i < jobs.length(); i++) if (DownloadProtocol.runnable(jobs.getJSONObject(i).optString("status"))) { getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(jobs.getJSONObject(i))); break; }
                delay = 1000; return;
            }
            currentId = id; JSONObject item = store.nextItem(id);
            if (item == null) { store.finalizeJob(id); changed(this); return; }
            JSONObject origin = item.getJSONObject("origin"); String source = origin.getString("source");
            long cooldown = store.cooldown(source);
            if (cooldown > System.currentTimeMillis()) { store.waitUntil(id, cooldown, "Источник просит подождать перед продолжением."); changed(this); return; }
            long nextAllowed = store.nextAllowed(source);
            if (nextAllowed > System.currentTimeMillis()) { delay = Math.min(30000, nextAllowed - System.currentTimeMillis()); return; }
            store.begin(id, item); getSystemService(NotificationManager.class).notify(NOTIFICATION, notification(store.summary(id))); changed(this);
            JSONObject content = store.readChapter(item.getString("key")); boolean realHttp = false;
            if (content == null) {
                keepAwake();
                MvpTransport.RequestControl control = new MvpTransport.RequestControl(); currentRequest = control;
                String path = DownloadProtocol.chapterPath(origin), session = MvpConnection.session(this); boolean offline = MvpConnection.offline(this);
                audit("start", id, path, offline, session, null);
                content = MvpTransport.request(MvpConnection.server(this), path, offline, control);
                store.deferSource(source, System.currentTimeMillis() + store.pacing(source));
                audit("finish", id, path, offline, session, content);
                currentRequest = null;
                if (stopping || control.cancelled) return;
                if (content.has("error")) { recovery.failed(source); store.failed(id, item, content); changed(this); return; }
                if (!DownloadProtocol.hasText(content)) { recovery.failed(source); store.failed(id, item, MvpTransport.error("Источник вернул раздел без текста.", 502, "SOURCE_FORMAT")); changed(this); return; }
                realHttp = true;
            }
            if (!stopping) { store.completed(id, item, content); store.httpSucceeded(id, source, recovery, realHttp); changed(this); }
            delay = store.pacing(source);
        } catch (Exception error) {
            try { if (currentId != null) store.storageError(currentId, "Загрузка остановлена: не удалось надёжно сохранить данные. " + error.getClass().getSimpleName()); } catch (Exception ignored) { }
            changed(this);
            finishService();
        } finally {
            currentRequest = null; currentId = null;
            // Retain the bounded wake lock across short inter-chapter pacing.
            // A foreground notification alone does not keep the CPU awake.
            boolean immediate = false;
            try { immediate = !stopping && store.nextJob(System.currentTimeMillis()) != null; } catch (Exception ignored) { }
            if (immediate) keepAwake();
            else if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            if (!stopping) { if (!store.active()) finishService(); else schedule(delay); }
        }
    }
    private void keepAwake() {
        if (wakeLock == null || stopping) return;
        long now = SystemClock.elapsedRealtime();
        if (!wakeLock.isHeld() || now - wakeRenewedAt >= 60000) {
            if (wakeLock.isHeld()) wakeLock.release();
            wakeLock.acquire(120000); wakeRenewedAt = now;
        }
    }
    private void audit(String phase, String id, String path, boolean offline, String session, JSONObject result) {
        if (!BuildConfig.DEBUG) return;
        try { JSONObject value = new JSONObject().put("event", "download-request").put("phase", phase).put("jobId", id).put("path", path).put("offline", offline).put("session", session).put("at", System.currentTimeMillis()); if (result != null) value.put("status", result.optInt("status", result.has("error") ? 0 : 200)).put("code", result.optString("code", "")); Log.i("GargantuaDownloads", value.toString()); } catch (Exception ignored) { }
    }
    private void finishService() { stopping = true; if (running == this) running = null; stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); changed(this); }
    @Override public void onTimeout(int startId, int foregroundServiceType) {
        stopping = true; MvpTransport.RequestControl request = currentRequest; if (request != null) request.cancel();
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
        String id = currentId;
        CONTROL.execute(() -> { try { if (id != null) store.waitUntil(id, System.currentTimeMillis() + 60000, "Android ограничил время фоновой загрузки. Откройте приложение для продолжения."); } catch (Exception ignored) { } });
        finishService();
    }
    @Override public void onDestroy() {
        stopping = true; if (running == this) running = null; MvpTransport.RequestControl request = currentRequest; if (request != null) request.cancel(); worker.shutdownNow(); if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); changed(this); super.onDestroy();
    }
}
