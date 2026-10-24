package local.gargantua.mvp;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import androidx.core.content.FileProvider;
import org.json.JSONObject;
import java.io.*;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Explicit document picker / Android share sheet; never selects or sends to a recipient. */
final class CatalogTransfer {
    interface Reply { void complete(Object result); }
    private static final int CREATE = 731, OPEN = 732;
    private final Activity activity;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final File root;
    private Reply pending;
    private CatalogArchive.Exported exported;
    private File work;
    private boolean closed;
    CatalogTransfer(Activity activity) { this.activity = activity; root = new File(activity.getCacheDir(), "catalog-transfer"); worker.execute(() -> { File[] old = root.listFiles(); if (old != null) for (File file : old) if (file.getName().matches("(?:import|export)-[a-f0-9-]{36}") && System.currentTimeMillis() - file.lastModified() > 86400000L) { try { remove(file); } catch (Exception ignored) { } } }); }
    private boolean begin(Reply reply) {
        if (pending != null) { reply.complete(failure("Дождитесь завершения текущего переноса каталога.", "CATALOG_BUSY")); return false; }
        pending = reply; return true;
    }
    private File folder(String prefix) throws Exception { if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Не удалось подготовить папку каталога."); File folder = new File(root, prefix + UUID.randomUUID()); if (!folder.mkdir()) throw new IOException("Не удалось подготовить временный каталог."); return folder; }
    private static String filename(JSONObject manifest) {
        String title = manifest.optString("name", "Гаргантюа").replaceAll("[^\\p{L}\\p{N} ._-]", "_").trim();
        if (title.length() > 80) title = title.substring(0, 80).trim();
        if (title.isEmpty() || title.equals(".") || title.equals("..")) title = "Гаргантюа";
        return title + ".gargantua.zip";
    }
    void exportCatalog(JSONObject manifest, boolean share, Reply reply) {
        if (!begin(reply)) return;
        worker.execute(() -> {
            try {
                File folder = folder("export-"); work = folder;
                CatalogArchive.Exported value = CatalogArchive.exportZip(manifest, folder, key -> DownloadStore.get(activity).readChapterBytes(key));
                exported = value;
                remove(new File(folder, "chapters"));
                activity.runOnUiThread(() -> {
                    if (closed) return;
                    try {
                        if (share) {
                            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".catalogs", value.file, filename(value.manifest));
                            Intent send = new Intent(Intent.ACTION_SEND).setType("application/zip").putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_TITLE, value.manifest.optString("name")).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            send.setClipData(ClipData.newRawUri("Каталог Гаргантюа", uri));
                            activity.startActivity(Intent.createChooser(send, "Передать каталог").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
                            complete(exportResult(value.manifest, true), false);
                        } else {
                            activity.startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip").putExtra(Intent.EXTRA_TITLE, filename(value.manifest)), CREATE);
                        }
                    } catch (Exception error) { complete(failure("Не удалось открыть выбор места сохранения или передачи.", "CATALOG_PICKER"), true); }
                });
            } catch (Exception error) { activity.runOnUiThread(() -> complete(error(error), true)); }
        });
    }
    void importCatalog(Reply reply) {
        if (!begin(reply)) return;
        try { activity.startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), OPEN); }
        catch (Exception error) { complete(failure("Не удалось открыть выбор файла каталога.", "CATALOG_PICKER"), true); }
    }
    boolean activityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != CREATE && requestCode != OPEN) return false;
        if (pending == null) return true;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) { complete(failure("Перенос каталога отменён.", "CATALOG_CANCELLED"), true); return true; }
        Uri uri = data.getData();
        if (!"content".equals(uri.getScheme())) { complete(failure("Выберите файл через системное приложение документов.", "CATALOG_INVALID"), true); return true; }
        worker.execute(() -> {
            try {
                if (requestCode == CREATE) {
                    CatalogArchive.Exported value = exported; if (value == null) throw new IOException("Каталог ещё не подготовлен.");
                    try (InputStream input = new FileInputStream(value.file); OutputStream target = activity.getContentResolver().openOutputStream(uri, "w")) { if (target == null) throw new IOException("Место сохранения недоступно."); CatalogArchive.copy(input, target, CatalogArchive.MAX_COMPRESSED); target.flush(); }
                    activity.runOnUiThread(() -> { try { complete(exportResult(value.manifest, false), true); } catch (Exception error) { complete(error(error), true); } });
                } else {
                    File folder = folder("import-"); work = folder; CatalogArchive.Prepared value;
                    try (InputStream input = activity.getContentResolver().openInputStream(uri)) { if (input == null) throw new IOException("Файл недоступен."); value = CatalogArchive.readZip(input, folder); }
                    // All ZIP names, membership, counts, sizes, hashes and JSON passed
                    // before the single native-cache transaction can publish anything.
                    DownloadStore.get(activity).importChapters(value.chapters);
                    DownloadService.changed(activity);
                    activity.runOnUiThread(() -> complete(value.manifest, true));
                }
            } catch (Exception error) { activity.runOnUiThread(() -> complete(error(error), true)); }
        });
        return true;
    }
    private static JSONObject exportResult(JSONObject manifest, boolean share) throws Exception { return new JSONObject().put("saved", true).put("shared", share).put("shareOpened", share).put("name", manifest.getString("name")).put("chapterCount", manifest.getInt("chapterCount")).put("cachedChapterCount", manifest.getInt("cachedChapterCount")).put("uniqueCachedChapterCount", manifest.getInt("uniqueCachedChapterCount")); }
    private static JSONObject failure(String message, String code) { return MvpTransport.error(message, 400, code); }
    private static JSONObject error(Exception error) {
        if (BuildConfig.DEBUG) {
            // JSON parser exception messages may contain chapter text. Keep only
            // the exception class and source locations in private debug evidence.
            Throwable diagnostic = new Throwable(error.getClass().getName()); diagnostic.setStackTrace(error.getStackTrace());
            Log.e("GargantuaCatalog", "catalog-transfer " + error.getClass().getName(), diagnostic);
        }
        String message = error.getMessage(); boolean conflict = message != null && message.contains("другая версия"); return failure(conflict || error instanceof CatalogArchive.Invalid ? message : "Не удалось перенести каталог. Проверьте файл и свободное место. Книги не изменены.", conflict ? "CATALOG_CONFLICT" : "CATALOG_INVALID");
    }
    private void complete(Object value, boolean clean) {
        Reply reply = pending; pending = null; exported = null;
        File folder = work; work = null;
        if (clean && folder != null && !worker.isShutdown()) worker.execute(() -> { try { remove(folder); } catch (Exception ignored) { } });
        if (!closed && reply != null) reply.complete(value);
    }
    private void remove(File file) throws Exception {
        String allowed = root.getCanonicalPath() + File.separator, path = file.getCanonicalPath(); if (!path.startsWith(allowed)) throw new IOException("Недопустимый временный путь.");
        if (file.isDirectory()) { File[] children = file.listFiles(); if (children != null) for (File child : children) remove(child); }
        if (file.exists() && !file.delete()) throw new IOException("Не удалось очистить временный каталог.");
    }
    void close() { closed = true; pending = null; worker.shutdownNow(); }
}
