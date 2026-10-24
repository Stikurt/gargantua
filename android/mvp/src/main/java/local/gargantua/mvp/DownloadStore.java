package local.gargantua.mvp;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Chunked chapter cache and checkpoints are committed in the same SQLite transaction. */
final class DownloadStore extends SQLiteOpenHelper {
    private static DownloadStore instance;
    static synchronized DownloadStore get(Context context) { if (instance == null) instance = new DownloadStore(context.getApplicationContext()); return instance; }
    private DownloadStore(Context context) { super(context, "gargantua-downloads.db", null, 2); setWriteAheadLoggingEnabled(true); }
    @Override public void onConfigure(SQLiteDatabase db) { db.execSQL("PRAGMA foreign_keys=ON"); db.execSQL("PRAGMA synchronous=FULL"); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE jobs(id TEXT PRIMARY KEY, meta TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE items(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, key TEXT NOT NULL, descriptor TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(job_id,key))");
        db.execSQL("CREATE INDEX items_order ON items(job_id,ordinal)");
        db.execSQL("CREATE TABLE chapters(key TEXT PRIMARY KEY, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, parts INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE chapter_chunks(key TEXT NOT NULL REFERENCES chapters(key) ON DELETE CASCADE,n INTEGER NOT NULL,value BLOB NOT NULL,PRIMARY KEY(key,n))");
        db.execSQL("CREATE TABLE source_policy(source TEXT PRIMARY KEY,cooldown INTEGER NOT NULL DEFAULT 0,pacing INTEGER NOT NULL DEFAULT 1000,rate_limits INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { if (oldVersion == 1 && newVersion == 2) db.execSQL("ALTER TABLE source_policy ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0"); else throw new IllegalStateException("Неизвестная версия базы загрузок."); }
    private static String digest(byte[] bytes) throws Exception { byte[] hash = MessageDigest.getInstance("SHA-256").digest(bytes); StringBuilder text = new StringBuilder(); for (byte value : hash) text.append(String.format(java.util.Locale.ROOT, "%02x", value & 255)); return text.toString(); }
    private boolean cached(SQLiteDatabase db, String key) { try (Cursor rows = db.rawQuery("SELECT 1 FROM chapters WHERE key=?", new String[]{key})) { return rows.moveToFirst(); } }
    private JSONObject meta(SQLiteDatabase db, String id) throws Exception { try (Cursor rows = db.rawQuery("SELECT meta,status FROM jobs WHERE id=?", new String[]{id})) { if (!rows.moveToFirst()) return null; JSONObject value = new JSONObject(rows.getString(0)); value.put("status", rows.getString(1)); return value; } }
    private void saveMeta(SQLiteDatabase db, JSONObject job) throws Exception { ContentValues row = new ContentValues(); row.put("meta", job.toString()); row.put("status", job.getString("status")); db.update("jobs", row, "id=?", new String[]{job.getString("id")}); }
    private void finish(SQLiteDatabase db, JSONObject job) throws Exception {
        if (!DownloadProtocol.runnable(job.optString("status"))) return;
        try (Cursor rows = db.rawQuery("SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),SUM(CASE WHEN status IN ('failed','unavailable') THEN 1 ELSE 0 END) FROM items WHERE job_id=?", new String[]{job.getString("id")})) {
            rows.moveToFirst(); if (rows.getInt(0) == 0) { boolean partial = rows.getInt(1) > 0; job.put("status", partial ? "partial" : "complete").put("currentTitle", "").put("currentSource", "").put("currentOrigin", JSONObject.NULL).put("retryAt", JSONObject.NULL).put("error", partial ? "Сохранены доступные разделы. Часть разделов недоступна." : ""); }
        }
    }
    synchronized JSONObject enqueue(JSONObject raw) throws Exception {
        JSONObject job = DownloadProtocol.job(raw); JSONArray items = job.getJSONArray("items"); job.remove("items");
        job.remove("imported");
        String id = job.getString("id"), requested = job.optString("status");
        job.put("status", requested.equals("paused") || requested.equals("error") ? requested : job.optLong("retryAt") > System.currentTimeMillis() ? "waiting" : "queued").put("updatedAt", System.currentTimeMillis()).put("currentTitle", "").put("currentSource", "").put("currentOrigin", JSONObject.NULL);
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            JSONObject old = meta(db, id); if (old != null) job.put("createdAt", old.optLong("createdAt", System.currentTimeMillis()));
            if (!job.has("createdAt")) job.put("createdAt", System.currentTimeMillis());
            ContentValues row = new ContentValues(); row.put("id", id); row.put("meta", job.toString()); row.put("status", job.getString("status")); row.put("created_at", job.getLong("createdAt"));
            db.insertWithOnConflict("jobs", null, row, SQLiteDatabase.CONFLICT_REPLACE);
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.getJSONObject(i); String key = item.getString("key"); String state = cached(db, key) ? "downloaded" : item.getJSONObject("chapter").optBoolean("available", true) ? "pending" : "unavailable";
                row = new ContentValues(); row.put("job_id", id); row.put("ordinal", i); row.put("key", key); item.remove("status"); item.remove("error"); item.remove("attempts"); row.put("descriptor", item.toString()); row.put("status", state); row.put("error", ""); row.put("attempts", 0); db.insertOrThrow("items", null, row);
            }
            for (String source : keys(job.optJSONObject("sourceCooldowns"))) {
                long until = job.getJSONObject("sourceCooldowns").optLong(source); ContentValues policy = new ContentValues(); policy.put("source", source); policy.put("cooldown", Math.max(until, cooldown(source))); policy.put("next_at", nextAllowed(source)); policy.put("pacing", Math.max(pacing(source), DownloadPacing.normalized(job.optJSONObject("sourcePacingMs") == null ? DownloadPacing.FLOOR_MS : job.getJSONObject("sourcePacingMs").optLong(source, DownloadPacing.FLOOR_MS)))); db.insertWithOnConflict("source_policy", null, policy, SQLiteDatabase.CONFLICT_REPLACE);
            }
            finish(db, job); saveMeta(db, job); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        return summary(id);
    }
    private static Iterable<String> keys(JSONObject value) { java.util.ArrayList<String> values = new java.util.ArrayList<>(); if (value != null) { java.util.Iterator<String> iterator = value.keys(); while (iterator.hasNext()) values.add(iterator.next()); } return values; }
    synchronized JSONObject readChapter(String key) throws Exception {
        byte[] value = readChapterBytes(key); if (value == null) return null;
        JSONObject content = new JSONObject(new String(value, StandardCharsets.UTF_8)); if (!DownloadProtocol.hasText(content)) throw new IllegalStateException("В сохранённом разделе нет текста."); return content;
    }
    synchronized byte[] readChapterBytes(String key) throws Exception {
        DownloadProtocol.validateKey(key); SQLiteDatabase db = getReadableDatabase(); int bytes, parts; String hash;
        try (Cursor row = db.rawQuery("SELECT bytes,sha256,parts FROM chapters WHERE key=?", new String[]{key})) { if (!row.moveToFirst()) return null; bytes = row.getInt(0); hash = row.getString(1); parts = row.getInt(2); }
        ByteArrayOutputStream output = new ByteArrayOutputStream(bytes); int n = 0;
        try (Cursor rows = db.rawQuery("SELECT n,value FROM chapter_chunks WHERE key=? ORDER BY n", new String[]{key})) { while (rows.moveToNext()) { if (rows.getInt(0) != n++) throw new IllegalStateException("Повреждён порядок сохранённого текста."); output.write(rows.getBlob(1)); } }
        byte[] value = output.toByteArray(); if (n != parts || value.length != bytes || !digest(value).equals(hash)) throw new IllegalStateException("Сохранённый раздел не прошёл проверку целостности.");
        return value;
    }
    private void putChapter(SQLiteDatabase db, String key, JSONObject content) throws Exception {
        DownloadProtocol.validateKey(key); if (!DownloadProtocol.hasText(content)) throw new IllegalArgumentException("Нельзя сохранить пустой раздел.");
        byte[] existing = readChapterBytes(key);
        if (existing != null) {
            if (!CatalogArchive.canonical(CatalogArchive.parse(existing, CatalogArchive.MAX_CHAPTER)).equals(CatalogArchive.canonical(content))) throw new IllegalArgumentException("В каталоге другая версия сохранённого раздела; существующие книги не изменены.");
            return;
        }
        byte[] value = content.toString().getBytes(StandardCharsets.UTF_8); if (value.length > DownloadProtocol.MAX_CHAPTER_BYTES) throw new IllegalArgumentException("Слишком большой раздел.");
        db.delete("chapters", "key=?", new String[]{key}); ContentValues row = new ContentValues(); row.put("key", key); row.put("bytes", value.length); row.put("sha256", digest(value)); row.put("parts", (value.length + 65535) / 65536); db.insertOrThrow("chapters", null, row);
        for (int from = 0, n = 0; from < value.length; from += 65536, n++) { row = new ContentValues(); row.put("key", key); row.put("n", n); row.put("value", java.util.Arrays.copyOfRange(value, from, Math.min(value.length, from + 65536))); db.insertOrThrow("chapter_chunks", null, row); }
    }
    synchronized void saveChapter(String key, JSONObject content) throws Exception {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction(); try { putChapter(db, key, content); ContentValues row = new ContentValues(); row.put("status", "downloaded"); row.put("error", ""); db.update("items", row, "key=?", new String[]{key}); db.setTransactionSuccessful(); } finally { db.endTransaction(); }
    }
    synchronized JSONArray list() throws Exception { JSONArray values = new JSONArray(); try (Cursor rows = getReadableDatabase().rawQuery("SELECT id FROM jobs ORDER BY created_at DESC", null)) { while (rows.moveToNext()) values.put(summary(rows.getString(0))); } return values; }
    synchronized JSONObject summary(String id) throws Exception {
        SQLiteDatabase db = getReadableDatabase(); JSONObject value = meta(db, id); if (value == null) return null;
        try (Cursor rows = db.rawQuery("SELECT COUNT(*),SUM(CASE WHEN status='downloaded' THEN 1 ELSE 0 END),SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),SUM(CASE WHEN status='unavailable' THEN 1 ELSE 0 END) FROM items WHERE job_id=?", new String[]{id})) { rows.moveToFirst(); value.put("total", rows.getInt(0)).put("downloaded", rows.getInt(1)).put("failed", rows.getInt(2)).put("unavailable", rows.getInt(3)); }
        JSONArray failed = new JSONArray(); try (Cursor rows = db.rawQuery("SELECT descriptor,error FROM items WHERE job_id=? AND status='failed' ORDER BY ordinal LIMIT 50", new String[]{id})) { while (rows.moveToNext()) { JSONObject item = new JSONObject(rows.getString(0)); failed.put(new JSONObject().put("title", item.getJSONObject("chapter").optString("title")).put("origin", item.getJSONObject("origin")).put("error", rows.getString(1))); } } value.put("failedChapters", failed); return value;
    }
    synchronized JSONObject job(String id) throws Exception {
        JSONObject value = summary(id); if (value == null) return null; JSONArray items = new JSONArray();
        try (Cursor rows = getReadableDatabase().rawQuery("SELECT descriptor,status,error,attempts FROM items WHERE job_id=? ORDER BY ordinal", new String[]{id})) { while (rows.moveToNext()) items.put(new JSONObject(rows.getString(0)).put("status", rows.getString(1)).put("error", rows.getString(2)).put("attempts", rows.getInt(3))); } value.put("items", items); return value;
    }
    synchronized JSONArray jobs() throws Exception { JSONArray values = new JSONArray(); try (Cursor rows = getReadableDatabase().rawQuery("SELECT id FROM jobs ORDER BY created_at DESC", null)) { while (rows.moveToNext()) values.put(job(rows.getString(0))); } return values; }
    synchronized JSONObject pause(String id) throws Exception { return status(id, "paused", false); }
    synchronized JSONObject resume(String id) throws Exception { return status(id, "queued", true); }
    private JSONObject status(String id, String state, boolean retry) throws Exception {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction(); try {
            JSONObject value = meta(db, id); if (value == null) return null;
            if (!retry && !DownloadProtocol.runnable(value.optString("status"))) { db.setTransactionSuccessful(); return summary(id); }
            if (retry) { ContentValues item = new ContentValues(); item.put("status", "pending"); item.put("error", ""); item.put("attempts", 0); db.update("items", item, "job_id=? AND status='failed'", new String[]{id}); }
            value.put("status", state.equals("queued") && value.optLong("retryAt") > System.currentTimeMillis() ? "waiting" : state).put("currentTitle", "").put("currentSource", "").put("currentOrigin", JSONObject.NULL).put("updatedAt", System.currentTimeMillis()); finish(db, value); saveMeta(db, value); db.setTransactionSuccessful();
        } finally { db.endTransaction(); } return summary(id);
    }
    synchronized void cancel(String id) { getWritableDatabase().delete("jobs", "id=?", new String[]{id}); }
    synchronized boolean active() { try (Cursor rows = getReadableDatabase().rawQuery("SELECT 1 FROM jobs WHERE status IN ('queued','downloading','waiting') LIMIT 1", null)) { return rows.moveToFirst(); } }
    synchronized String nextJob(long now) throws Exception { try (Cursor rows = getReadableDatabase().rawQuery("SELECT id,meta FROM jobs WHERE status IN ('queued','downloading','waiting') ORDER BY created_at", null)) { while (rows.moveToNext()) if (new JSONObject(rows.getString(1)).optLong("retryAt") <= now) return rows.getString(0); } return null; }
    synchronized JSONObject nextItem(String id) throws Exception { try (Cursor rows = getReadableDatabase().rawQuery("SELECT descriptor,attempts FROM items WHERE job_id=? AND status='pending' ORDER BY ordinal LIMIT 1", new String[]{id})) { return rows.moveToFirst() ? new JSONObject(rows.getString(0)).put("attempts", rows.getInt(1)) : null; } }
    synchronized void begin(String id, JSONObject item) throws Exception { SQLiteDatabase db = getWritableDatabase(); JSONObject value = meta(db, id); if (value == null || !DownloadProtocol.runnable(value.optString("status"))) return; value.put("status", "downloading").put("currentTitle", item.getJSONObject("chapter").optString("title", "Раздел")).put("currentSource", item.getJSONObject("origin").getString("source")).put("currentOrigin", item.getJSONObject("origin")).put("error", ""); saveMeta(db, value); }
    synchronized void completed(String id, JSONObject item, JSONObject content) throws Exception {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction(); try { JSONObject value = meta(db, id); if (value == null) return; if (cached(db, item.getString("key"))) readChapterBytes(item.getString("key")); else putChapter(db, item.getString("key"), content); ContentValues state = new ContentValues(); state.put("status", "downloaded"); state.put("error", ""); db.update("items", state, "key=?", new String[]{item.getString("key")}); if (DownloadProtocol.runnable(value.optString("status"))) value.put("status", "queued"); value.put("currentTitle", "").put("currentSource", "").put("currentOrigin", JSONObject.NULL).put("retryAt", JSONObject.NULL).put("error", "").put("updatedAt", System.currentTimeMillis()); finish(db, value); saveMeta(db, value); db.setTransactionSuccessful(); } finally { db.endTransaction(); }
    }
    synchronized void finalizeJob(String id) throws Exception { SQLiteDatabase db = getWritableDatabase(); JSONObject value = meta(db, id); if (value != null) { finish(db, value); saveMeta(db, value); } }
    synchronized long cooldown(String source) { try (Cursor row = getReadableDatabase().rawQuery("SELECT cooldown FROM source_policy WHERE source=?", new String[]{source})) { return row.moveToFirst() ? row.getLong(0) : 0; } }
    synchronized long pacing(String source) { try (Cursor row = getReadableDatabase().rawQuery("SELECT pacing FROM source_policy WHERE source=?", new String[]{source})) { return row.moveToFirst() ? DownloadPacing.normalized(row.getLong(0)) : DownloadPacing.FLOOR_MS; } }
    synchronized void httpSucceeded(String id, String source, DownloadPacing recovery, boolean realHttp) throws Exception {
        if (!realHttp) return;
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            long pace = recovery.completed(source, pacing(source), cooldown(source), System.currentTimeMillis(), true);
            ContentValues policy = new ContentValues(); policy.put("pacing", pace); db.update("source_policy", policy, "source=?", new String[]{source});
            JSONObject job = meta(db, id);
            if (job != null) { JSONObject values = job.optJSONObject("sourcePacingMs"); if (values == null) values = new JSONObject(); values.put(source, pace); job.put("sourcePacingMs", values); saveMeta(db, job); }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    synchronized long nextAllowed(String source) { try (Cursor row = getReadableDatabase().rawQuery("SELECT next_at FROM source_policy WHERE source=?", new String[]{source})) { return row.moveToFirst() ? row.getLong(0) : 0; } }
    synchronized void deferSource(String source, long until) { SQLiteDatabase db = getWritableDatabase(); ContentValues value = new ContentValues(); value.put("source", source); db.insertWithOnConflict("source_policy", null, value, SQLiteDatabase.CONFLICT_IGNORE); value = new ContentValues(); value.put("next_at", until); db.update("source_policy", value, "source=?", new String[]{source}); }
    synchronized void waitUntil(String id, long until, String message) throws Exception { SQLiteDatabase db = getWritableDatabase(); JSONObject value = meta(db, id); if (value == null) return; if (DownloadProtocol.runnable(value.optString("status"))) value.put("status", "waiting"); value.put("retryAt", until).put("error", message).put("currentTitle", "").put("currentSource", "").put("currentOrigin", JSONObject.NULL); saveMeta(db, value); }
    synchronized void failed(String id, JSONObject item, JSONObject result) throws Exception {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction(); try {
            JSONObject value = meta(db, id); if (value == null) return; int attempts = item.optInt("attempts") + 1; String error = result.optString("error", "Не удалось загрузить раздел."); boolean retry = DownloadProtocol.rateLimited(result) || DownloadProtocol.networkError(result);
            ContentValues row = new ContentValues(); row.put("attempts", attempts); row.put("error", error); row.put("status", retry ? "pending" : "failed"); db.update("items", row, "job_id=? AND key=?", new String[]{id, item.getString("key")});
            if (retry) { long until = System.currentTimeMillis() + DownloadProtocol.retryDelay(result, attempts); if (DownloadProtocol.rateLimited(result)) { String source = item.getJSONObject("origin").getString("source"); int count = 1; try (Cursor old = db.rawQuery("SELECT rate_limits FROM source_policy WHERE source=?", new String[]{source})) { if (old.moveToFirst()) count += old.getInt(0); } long pacing = DownloadPacing.afterRateLimit(pacing(source)); until = Math.max(until, cooldown(source)); row = new ContentValues(); row.put("source", source); row.put("cooldown", until); row.put("next_at", nextAllowed(source)); row.put("pacing", pacing); row.put("rate_limits", count); db.insertWithOnConflict("source_policy", null, row, SQLiteDatabase.CONFLICT_REPLACE); JSONObject cooldowns = value.optJSONObject("sourceCooldowns"), paces = value.optJSONObject("sourcePacingMs"); if (cooldowns == null) cooldowns = new JSONObject(); if (paces == null) paces = new JSONObject(); value.put("sourceCooldowns", cooldowns.put(source, until)); value.put("sourcePacingMs", paces.put(source, pacing)); } if (DownloadProtocol.runnable(value.optString("status"))) value.put("status", "waiting"); value.put("retryAt", until); }
            else if (DownloadProtocol.runnable(value.optString("status"))) value.put("status", "queued");
            value.put("error", error).put("currentTitle", "").put("currentSource", "").put("currentOrigin", JSONObject.NULL).put("updatedAt", System.currentTimeMillis()); finish(db, value); saveMeta(db, value); db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    synchronized void storageError(String id, String error) throws Exception { SQLiteDatabase db = getWritableDatabase(); JSONObject value = meta(db, id); if (value != null) { value.put("status", "error").put("error", error).put("currentTitle", "").put("currentSource", ""); saveMeta(db, value); } }
    synchronized void importChapters(java.util.Map<String, java.io.File> chapters) throws Exception {
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            // Inspect every existing collision before the first mutation. Another
            // worker cannot interleave a cache commit inside this synchronized batch.
            for (java.util.Map.Entry<String, java.io.File> entry : chapters.entrySet()) {
                DownloadProtocol.validateKey(entry.getKey());
                JSONObject incoming = CatalogArchive.parse(CatalogArchive.chapterBytes(entry.getValue()), CatalogArchive.MAX_CHAPTER);
                if (!DownloadProtocol.hasText(incoming)) throw new IllegalArgumentException("В каталоге есть пустой раздел.");
                byte[] existing = readChapterBytes(entry.getKey());
                if (existing != null && !CatalogArchive.canonical(CatalogArchive.parse(existing, CatalogArchive.MAX_CHAPTER)).equals(CatalogArchive.canonical(incoming))) throw new IllegalArgumentException("В каталоге другая версия сохранённого раздела; существующие книги не изменены.");
            }
            for (java.util.Map.Entry<String, java.io.File> entry : chapters.entrySet()) {
                if (!cached(db, entry.getKey())) putChapter(db, entry.getKey(), CatalogArchive.parse(CatalogArchive.chapterBytes(entry.getValue()), CatalogArchive.MAX_CHAPTER));
                ContentValues state = new ContentValues(); state.put("status", "downloaded"); state.put("error", ""); db.update("items", state, "key=?", new String[]{entry.getKey()});
            }
            try (Cursor rows = db.rawQuery("SELECT id FROM jobs WHERE status!='paused' AND NOT EXISTS(SELECT 1 FROM items WHERE job_id=jobs.id AND status!='downloaded')", null)) {
                while (rows.moveToNext()) { JSONObject job = meta(db, rows.getString(0)); job.put("status", "complete").put("error", "").put("currentTitle", "").put("currentSource", "").put("currentOrigin", JSONObject.NULL).put("retryAt", JSONObject.NULL); saveMeta(db, job); }
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
}
