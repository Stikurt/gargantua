package local.gargantua.mvp;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/** File-backed, bounded catalog interchange. No URL, preference or executable entry exists. */
final class CatalogArchive {
    static final long MAX_COMPRESSED = 512L * 1024 * 1024, MAX_EXPANDED = 1024L * 1024 * 1024;
    static final int MAX_MANIFEST = 8 * 1024 * 1024, MAX_CHAPTER = 24 * 1024 * 1024;
    private static final Set<String> SOURCES = new HashSet<>(Arrays.asList("ranobelib", "ranobeme", "ranobehub", "libcat", "litlife", "wikisource", "gutenberg", "merged", "catalog"));
    private static String clean(String value, int max) { String text = value.replaceAll("(?iu)https?://\\S+", "").replaceAll("(?iu)\\b(?:[a-z0-9-]+\\.)+ts\\.net\\b", "").replaceAll("[\\x00-\\x1f\\x7f]", " ").replaceAll("[\\s\\p{Z}\\uFEFF]+", " ").trim(); return text.length() > max ? text.substring(0, max) : text; }
    private static void identifier(String value, boolean required) throws Invalid { if (required && value.isEmpty() || value.length() > 4096 || value.matches("(?s).*[\\x00-\\x1f\\x7f].*") || value.toLowerCase(Locale.ROOT).contains("http://") || value.toLowerCase(Locale.ROOT).contains("https://")) throw new Invalid("В каталоге неверный идентификатор книги или главы."); }
    interface Cache { byte[] read(String key) throws Exception; }
    static final class Prepared {
        final JSONObject manifest;
        final LinkedHashMap<String, File> chapters;
        Prepared(JSONObject manifest, LinkedHashMap<String, File> chapters) { this.manifest = manifest; this.chapters = chapters; }
    }
    static final class Exported {
        final File file; final JSONObject manifest;
        Exported(File file, JSONObject manifest) { this.file = file; this.manifest = manifest; }
    }
    static final class Invalid extends IOException { Invalid(String message) { super(message); } }
    private static String text(JSONObject value, String field, int max, boolean required) throws Exception {
        Object raw = value.opt(field); if (raw == null || raw == JSONObject.NULL) { if (required) throw new Invalid("В каталоге нет поля «" + field + "»."); return ""; }
        if (!(raw instanceof String) && !(raw instanceof Number)) throw new Invalid("Некорректное поле каталога: " + field);
        String text = String.valueOf(raw); if (text.length() > max || text.indexOf('\0') >= 0 || required && text.isEmpty()) throw new Invalid("Некорректное поле каталога: " + field); return text;
    }
    static JSONObject normalize(JSONObject input) throws Exception {
        if (!"gargantua-catalog".equals(input.optString("format")) || input.optInt("schemaVersion") != 1) throw new Invalid("Это не поддерживаемый каталог Гаргантюа.");
        String name = clean(text(input, "name", 10000, false), 80); if (name.isEmpty()) name = "Открытый каталог";
        JSONObject safe = new JSONObject().put("format", "gargantua-catalog").put("schemaVersion", 1).put("name", name).put("createdAt", text(input, "createdAt", 100, true));
        JSONArray books = input.optJSONArray("books"); if (books == null || books.length() == 0 || books.length() > 1000) throw new Invalid("В каталоге должно быть от 1 до 1000 книг.");
        JSONArray output = new JSONArray(); int total = 0, cached = 0; Set<String> unique = new HashSet<>(), bookIdentities = new HashSet<>();
        for (int i = 0; i < books.length(); i++) {
            JSONObject row = books.getJSONObject(i), original = row.getJSONObject("book"), book = new JSONObject();
            for (String field : new String[]{"source", "id", "title", "kind", "language", "sourceName"}) book.put(field, text(original, field, field.equals("id") ? 4096 : 10000, field.equals("source") || field.equals("id")));
            if (!SOURCES.contains(book.getString("source"))) throw new Invalid("В каталоге указан неизвестный источник книги.");
            identifier(book.getString("id"), true);
            if (!bookIdentities.add(book.getString("source") + ":" + book.getString("id"))) throw new Invalid("В каталоге повторяется одна и та же книга.");
            String title = clean(book.getString("title"), 500); if (title.isEmpty()) throw new Invalid("В каталоге у книги отсутствует название.");
            book.put("title", title).put("kind", book.optString("kind").equals("novel") ? "novel" : "book").put("language", clean(book.optString("language"), 40)).put("sourceName", clean(book.optString("sourceName"), 80));
            Object author = original.opt("author"); if (author instanceof JSONArray) { JSONArray authors = (JSONArray) author; StringBuilder names = new StringBuilder(); if (authors.length() > 100) throw new Invalid("Слишком много авторов книги."); for (int a = 0; a < authors.length(); a++) { Object authorName = authors.get(a); if (!(authorName instanceof String) || ((String) authorName).length() > 1000) throw new Invalid("Некорректный автор."); if (names.length() > 0) names.append(", "); names.append(authorName); } book.put("author", clean(names.toString(), 500)); } else book.put("author", clean(text(original, "author", 10000, false), 500));
            JSONArray chapters = row.optJSONArray("chapters"), declared = row.optJSONArray("chapterKeys"), declaredCached = row.optJSONArray("cachedChapterKeys");
            if (chapters == null || declared == null || declaredCached == null || chapters.length() != declared.length()) throw new Invalid("Оглавление каталога не совпадает с ключами глав.");
            total += chapters.length(); if (total > 50000) throw new Invalid("В каталоге больше 50000 разделов.");
            JSONArray cleanChapters = new JSONArray(), keys = new JSONArray(), cacheKeys = new JSONArray(); Set<String> seen = new HashSet<>(), selected = new HashSet<>();
            for (int n = 0; n < declaredCached.length(); n++) { String key = declaredCached.getString(n); if (!selected.add(key)) throw new Invalid("Сохранённый раздел повторён в книге."); }
            for (int n = 0; n < chapters.length(); n++) {
                JSONObject chapter = chapters.getJSONObject(n), origin = DownloadProtocol.origin(chapter.getJSONObject("origin"));
                if (!SOURCES.contains(origin.getString("source")) || origin.getString("source").equals("merged")) throw new Invalid("В каталоге указан неизвестный источник главы.");
                identifier(origin.getString("bookId"), true); identifier(origin.getString("chapterId"), true); identifier(origin.getString("branchId"), false);
                String key = DownloadProtocol.key(origin);
                if (!key.equals(declared.getString(n)) || !seen.add(key)) throw new Invalid("Повтор или неверный ключ раздела в оглавлении.");
                String chapterId = text(chapter, "id", 4096, false); if (chapterId.matches("(?s).*[\\x00-\\x1f\\x7f].*")) throw new Invalid("В каталоге неверный номер главы.");
                String chapterTitle = clean(text(chapter, "title", 10000, false), 500);
                JSONObject clean = new JSONObject().put("id", chapterId).put("title", chapterTitle.isEmpty() ? "Раздел " + (n + 1) : chapterTitle).put("available", chapter.optBoolean("available", true)).put("origin", origin);
                if (chapter.has("number")) clean.put("number", clean(text(chapter, "number", 10000, false), 80));
                cleanChapters.put(clean); keys.put(key); if (selected.remove(key)) { cacheKeys.put(key); unique.add(key); cached++; }
            }
            if (!selected.isEmpty()) throw new Invalid("Сохранённый раздел отсутствует в оглавлении.");
            if (!cacheKeys.toString().equals(declaredCached.toString())) throw new Invalid("Порядок сохранённых разделов отличается от оглавления.");
            output.put(new JSONObject().put("book", book).put("chapters", cleanChapters).put("branches", new JSONArray()).put("downloadBranchId", "").put("chapterKeys", keys).put("cachedChapterKeys", cacheKeys));
        }
        if (input.optInt("chapterCount", -1) != total || input.optInt("cachedChapterCount", -1) != cached) throw new Invalid("Количество разделов в каталоге не совпадает с оглавлением.");
        safe.put("books", output).put("chapterCount", total).put("cachedChapterCount", cached).put("uniqueCachedChapterCount", unique.size()).put("partial", cached < total);
        if (safe.toString().getBytes(StandardCharsets.UTF_8).length > MAX_MANIFEST) throw new Invalid("Описание каталога превышает 8 МиБ."); return safe;
    }
    static JSONObject parse(byte[] bytes, int limit) throws Exception {
        if (bytes.length == 0 || bytes.length > limit) throw new Invalid("Недопустимый размер JSON в каталоге.");
        String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        int depth = 0, tokens = 0; boolean quoted = false, escaped = false;
        for (int i = 0; i < text.length(); i++) { char c = text.charAt(i); if (quoted) { if (escaped) escaped = false; else if (c == '\\') escaped = true; else if (c == '"') quoted = false; } else if (c == '"') quoted = true; else if (c == '{' || c == '[') { if (++depth > 64) throw new Invalid("Слишком глубокая структура JSON."); } else if (c == '}' || c == ']') depth--; else if (c == ',' || c == ':') { if (++tokens > (limit == MAX_MANIFEST ? 1500000 : 200000)) throw new Invalid("Слишком сложная структура раздела."); } }
        JSONTokener reader = new JSONTokener(text); Object value = reader.nextValue(); if (!(value instanceof JSONObject) || reader.nextClean() != 0) throw new Invalid("Некорректный JSON каталога."); return (JSONObject) value;
    }
    static String canonical(Object value) throws Exception {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject) { JSONObject object = (JSONObject) value; ArrayList<String> keys = new ArrayList<>(); Iterator<String> names = object.keys(); while (names.hasNext()) keys.add(names.next()); Collections.sort(keys); StringBuilder out = new StringBuilder("{"); for (String key : keys) { if (out.length() > 1) out.append(','); out.append(JSONObject.quote(key)).append(':').append(canonical(object.get(key))); } return out.append('}').toString(); }
        if (value instanceof JSONArray) { JSONArray array = (JSONArray) value; StringBuilder out = new StringBuilder("["); for (int i = 0; i < array.length(); i++) { if (i > 0) out.append(','); out.append(canonical(array.get(i))); } return out.append(']').toString(); }
        if (value instanceof String) return JSONObject.quote((String) value);
        if (value instanceof Number) return JSONObject.numberToString((Number) value);
        if (value instanceof Boolean) return value.toString(); throw new Invalid("Неподдерживаемое значение JSON.");
    }
    static String sha(byte[] bytes) throws Exception { byte[] value = MessageDigest.getInstance("SHA-256").digest(bytes); StringBuilder out = new StringBuilder(); for (byte b : value) out.append(String.format(Locale.ROOT, "%02x", b & 255)); return out.toString(); }
    static String sha(File file) throws Exception { MessageDigest hash = MessageDigest.getInstance("SHA-256"); try (InputStream input = new FileInputStream(file)) { byte[] buffer = new byte[65536]; int count; while ((count = input.read(buffer)) != -1) hash.update(buffer, 0, count); } byte[] bytes = hash.digest(); StringBuilder out = new StringBuilder(); for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255)); return out.toString(); }
    private static byte[] read(File file, int limit) throws Exception { if (file.length() > limit) throw new Invalid("Слишком большой раздел в каталоге."); ByteArrayOutputStream out = new ByteArrayOutputStream(); try (InputStream in = new FileInputStream(file)) { copy(in, out, limit); } return out.toByteArray(); }
    static long copy(InputStream input, OutputStream output, long limit) throws IOException { long bytes = 0; byte[] buffer = new byte[65536]; int count; while ((count = input.read(buffer)) != -1) { if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Перенос каталога остановлен."); bytes += count; if (bytes > limit) throw new Invalid("Каталог превышает допустимый размер."); output.write(buffer, 0, count); } return bytes; }
    static Exported exportZip(JSONObject input, File folder, Cache cache) throws Exception {
        JSONObject manifest = normalize(input); JSONArray books = manifest.getJSONArray("books"), entries = new JSONArray(); LinkedHashMap<String, File> files = new LinkedHashMap<>(); int logicalCached = 0; long expanded = 0;
        File chapterFolder = new File(folder, "chapters"); if (!chapterFolder.mkdir()) throw new IOException("Не удалось подготовить файлы каталога.");
        for (int b = 0; b < books.length(); b++) { JSONObject book = books.getJSONObject(b); JSONArray keys = book.getJSONArray("chapterKeys"), saved = new JSONArray();
            for (int i = 0; i < keys.length(); i++) { String key = keys.getString(i); File file = files.get(key);
                if (file == null) { byte[] bytes = cache.read(key); if (bytes == null) continue; if (bytes.length > MAX_CHAPTER || !DownloadProtocol.hasText(parse(bytes, MAX_CHAPTER))) throw new Invalid("Сохранённый раздел повреждён или пуст."); expanded += bytes.length; if (expanded > MAX_EXPANDED) throw new Invalid("Каталог превышает 1 ГиБ распакованных данных."); String path = String.format(Locale.ROOT, "chapters/%06d.json", files.size() + 1); file = new File(folder, path); try (OutputStream output = new FileOutputStream(file)) { output.write(bytes); } files.put(key, file); entries.put(new JSONObject().put("key", key).put("path", path).put("sha256", sha(bytes)).put("bytes", bytes.length)); }
                saved.put(key); logicalCached++;
            } book.put("cachedChapterKeys", saved);
        }
        manifest.put("cachedChapterCount", logicalCached).put("uniqueCachedChapterCount", files.size()).put("partial", logicalCached < manifest.getInt("chapterCount")).put("entries", entries);
        byte[] descriptor = manifest.toString().getBytes(StandardCharsets.UTF_8); if (descriptor.length > MAX_MANIFEST || expanded + descriptor.length > MAX_EXPANDED) throw new Invalid("Описание каталога превышает допустимый размер.");
        File zip = new File(folder, "catalog.zip");
        try (OutputStream target = new FileOutputStream(zip); ZipOutputStream output = new ZipOutputStream(new FilterOutputStream(target) { long written; @Override public void write(byte[] bytes, int off, int count) throws IOException { written += count; if (written > MAX_COMPRESSED) throw new Invalid("Сжатый каталог превышает 512 МиБ."); out.write(bytes, off, count); } @Override public void write(int value) throws IOException { if (++written > MAX_COMPRESSED) throw new Invalid("Сжатый каталог превышает 512 МиБ."); out.write(value); } })) {
            output.putNextEntry(new ZipEntry("catalog.json")); output.write(descriptor); output.closeEntry();
            for (int i = 0; i < entries.length(); i++) { JSONObject entry = entries.getJSONObject(i); output.putNextEntry(new ZipEntry(entry.getString("path"))); try (InputStream file = new FileInputStream(files.get(entry.getString("key")))) { copy(file, output, MAX_CHAPTER); } output.closeEntry(); }
        }
        return new Exported(zip, manifest);
    }
    static Prepared readZip(InputStream source, File folder) throws Exception {
        File zip = new File(folder, "input.zip"); try (OutputStream target = new FileOutputStream(zip)) { copy(source, target, MAX_COMPRESSED); }
        Map<String, File> paths = new LinkedHashMap<>(); long expanded = 0;
        try (ZipInputStream input = new ZipInputStream(new FileInputStream(zip), StandardCharsets.UTF_8)) {
            ZipEntry entry; while ((entry = input.getNextEntry()) != null) {
                String name = entry.getName();
                if (entry.isDirectory() || !(name.equals("catalog.json") || name.matches("chapters/[0-9]{6}\\.json")) || paths.containsKey(name) || paths.size() >= 50001) throw new Invalid("Каталог содержит повтор, посторонний файл или недопустимый путь.");
                int limit = name.equals("catalog.json") ? MAX_MANIFEST : MAX_CHAPTER; File file = new File(folder, name.equals("catalog.json") ? "manifest.json" : "part-" + name.substring(9)); long size;
                try (OutputStream target = new FileOutputStream(file)) { size = copy(input, target, Math.min(limit, MAX_EXPANDED - expanded)); }
                expanded += size; if (expanded > MAX_EXPANDED) throw new Invalid("Каталог превышает 1 ГиБ распакованных данных."); paths.put(name, file); input.closeEntry();
            }
        }
        File descriptor = paths.remove("catalog.json"); if (descriptor == null) throw new Invalid("В архиве нет catalog.json.");
        JSONObject original = parse(read(descriptor, MAX_MANIFEST), MAX_MANIFEST), manifest = normalize(original); JSONArray entries = original.optJSONArray("entries");
        if (entries == null || entries.length() > 50000) throw new Invalid("В каталоге нет корректного списка сохранённых разделов.");
        Set<String> expected = new HashSet<>(), usedPaths = new HashSet<>(); JSONArray books = manifest.getJSONArray("books"); for (int b = 0; b < books.length(); b++) { JSONArray keys = books.getJSONObject(b).getJSONArray("cachedChapterKeys"); for (int i = 0; i < keys.length(); i++) expected.add(keys.getString(i)); }
        LinkedHashMap<String, File> chapters = new LinkedHashMap<>(); JSONArray safeEntries = new JSONArray();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.getJSONObject(i); String key = entry.getString("key"), path = entry.getString("path"), hash = entry.getString("sha256"); File file = paths.get(path);
            if (!expected.remove(key) || !usedPaths.add(path) || file == null || !hash.matches("[a-f0-9]{64}") || entry.optLong("bytes", -1) != file.length() || !sha(file).equals(hash)) throw new Invalid("Не совпали список, размер или SHA-256 сохранённых разделов.");
            JSONObject content = parse(read(file, MAX_CHAPTER), MAX_CHAPTER); if (!DownloadProtocol.hasText(content)) throw new Invalid("В сохранённом разделе нет текста.");
            chapters.put(key, file); safeEntries.put(new JSONObject().put("key", key).put("path", path).put("sha256", hash).put("bytes", file.length()));
        }
        if (!expected.isEmpty() || paths.size() != usedPaths.size()) throw new Invalid("В каталоге пропущены или добавлены разделы.");
        manifest.put("entries", safeEntries); return new Prepared(manifest, chapters);
    }
    static byte[] chapterBytes(File file) throws Exception { return read(file, MAX_CHAPTER); }
}
