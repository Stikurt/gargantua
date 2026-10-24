package local.gargantua.mvp;

import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

/** Plain data validation shared by the persistent worker and JVM tests. */
final class DownloadProtocol {
    static final int MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
    static final int MAX_CHAPTER_BYTES = 24 * 1024 * 1024;
    static boolean runnable(String value) { return value.equals("queued") || value.equals("downloading") || value.equals("waiting"); }
    static String string(JSONObject value, String key, int max) throws Exception {
        Object raw = value.get(key);
        if (!(raw instanceof String) && !(raw instanceof Number)) throw new IllegalArgumentException("Некорректное поле: " + key);
        String text = String.valueOf(raw);
        if (text.isEmpty() || text.length() > max || text.indexOf('\0') >= 0) throw new IllegalArgumentException("Некорректное поле: " + key);
        return text;
    }
    static JSONObject origin(JSONObject input) throws Exception {
        String source = string(input, "source", 64);
        if (!source.matches("[a-z][a-z0-9-]{0,63}") || source.equals("merged")) throw new IllegalArgumentException("Некорректный источник раздела.");
        String branch = input.optString("branchId", "");
        if (branch.length() > 2048 || branch.indexOf('\0') >= 0) throw new IllegalArgumentException("Некорректная ветка.");
        return new JSONObject().put("source", source).put("bookId", string(input, "bookId", 4096)).put("chapterId", string(input, "chapterId", 4096)).put("branchId", branch);
    }
    static String key(JSONObject value) throws Exception {
        JSONObject safe = origin(value);
        return new JSONArray().put(safe.getString("source")).put(safe.getString("bookId")).put(safe.getString("branchId")).put(safe.getString("chapterId")).toString();
    }
    static String validateKey(String key) throws Exception {
        if (key == null || key.length() > 16384) throw new IllegalArgumentException("Некорректный ключ раздела.");
        JSONArray parts = new JSONArray(key);
        if (parts.length() != 4) throw new IllegalArgumentException("Некорректный ключ раздела.");
        JSONObject value = new JSONObject().put("source", parts.getString(0)).put("bookId", parts.getString(1)).put("branchId", parts.getString(2)).put("chapterId", parts.getString(3));
        if (!key(value).equals(key)) throw new IllegalArgumentException("Ключ раздела не совпадает с источником.");
        return key;
    }
    private static String encoded(String value) throws java.io.UnsupportedEncodingException { return URLEncoder.encode(value, "UTF-8").replace("+", "%20"); }
    static String chapterPath(JSONObject value) throws Exception {
        JSONObject safe = origin(value);
        return ServerAddress.apiPath("/api/mvp/chapter?source=" + encoded(safe.getString("source")) + "&id=" + encoded(safe.getString("bookId")) + "&chapterId=" + encoded(safe.getString("chapterId")) + (safe.getString("branchId").isEmpty() ? "" : "&branchId=" + encoded(safe.getString("branchId"))));
    }
    static boolean hasText(JSONObject content) {
        if (content == null || content.has("error")) return false;
        JSONArray paragraphs = content.optJSONArray("paragraphs");
        if (paragraphs != null) {
            for (int i = 0; i < paragraphs.length(); i++) { Object value = paragraphs.opt(i); if (value instanceof String && !((String) value).trim().isEmpty()) return true; }
            return false;
        }
        Object text = content.opt("text"); return text instanceof String && !((String) text).trim().isEmpty();
    }
    static JSONObject job(JSONObject input) throws Exception {
        if (input.toString().getBytes(StandardCharsets.UTF_8).length > MAX_MESSAGE_BYTES) throw new IllegalArgumentException("Оглавление превышает допустимый размер.");
        JSONObject safe = new JSONObject(input.toString());
        string(safe, "id", 16384); string(safe, "outlineKey", 256);
        if (safe.optJSONObject("book") == null) throw new IllegalArgumentException("Нет описания книги.");
        safe.getJSONObject("book").remove("chapters");
        JSONArray items = safe.optJSONArray("items");
        if (items == null || items.length() < 1 || items.length() > 20000) throw new IllegalArgumentException("В оглавлении должно быть от 1 до 20000 разделов.");
        Set<String> keys = new HashSet<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.getJSONObject(i), chapter = item.optJSONObject("chapter");
            if (chapter == null) throw new IllegalArgumentException("Нет описания раздела.");
            JSONObject from = origin(item.getJSONObject("origin")); String key = key(from);
            if (!key.equals(item.getString("key")) || !keys.add(key)) throw new IllegalArgumentException("Оглавление содержит повтор или неверный ключ раздела.");
            chapterPath(from); item.put("origin", from);
            if (item.toString().getBytes(StandardCharsets.UTF_8).length > 128 * 1024) throw new IllegalArgumentException("Описание раздела слишком большое.");
        }
        JSONObject meta = new JSONObject(safe.toString()); meta.remove("items");
        if (meta.toString().getBytes(StandardCharsets.UTF_8).length > 256 * 1024) throw new IllegalArgumentException("Описание книги слишком большое.");
        return safe;
    }
    static boolean rateLimited(JSONObject result) { return result.optInt("status") == 429 || result.optString("code").equals("SOURCE_RATE_LIMIT"); }
    static boolean networkError(JSONObject result) {
        int status = result.optInt("status"); String code = result.optString("code");
        return status == 408 || status == 503 || status == 504 || code.equals("SOURCE_NETWORK") || code.equals("SOURCE_TIMEOUT") || code.equals("SOURCE_UNAVAILABLE") || code.equals("SERVER_OFFLINE");
    }
    static long retryDelay(JSONObject result, int attempts) {
        if (rateLimited(result)) { double wait = result.optDouble("retryAfterMs", Double.NaN); return Double.isFinite(wait) && wait >= 0 ? Math.max(1000, Math.min(604800000, (long) wait)) : 60000; }
        return Math.min(300000, 30000L << Math.min(4, Math.max(0, attempts - 1)));
    }
}
