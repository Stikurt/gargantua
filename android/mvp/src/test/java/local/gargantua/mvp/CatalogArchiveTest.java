package local.gargantua.mvp;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.zip.*;
import static org.junit.Assert.*;

public class CatalogArchiveTest {
    private JSONObject content() throws Exception { return new JSONObject().put("title", "Глава 1").put("paragraphs", new JSONArray().put("Текст для чтения без интернета.")); }
    private String key() throws Exception { return DownloadProtocol.key(new JSONObject().put("source", "wikisource").put("bookId", "Проверочная книга").put("branchId", "").put("chapterId", "1")); }
    private JSONObject manifest(int editions, boolean cached) throws Exception {
        JSONObject origin = new JSONObject().put("source", "wikisource").put("bookId", "Проверочная книга").put("branchId", "").put("chapterId", "1"); JSONArray books = new JSONArray();
        for (int i = 0; i < editions; i++) books.put(new JSONObject().put("book", new JSONObject().put("source", "wikisource").put("id", "edition-" + i).put("title", "Проверочная книга").put("author", "Автор").put("server", "https://private.invalid").put("credentials", "should-not-export")).put("chapters", new JSONArray().put(new JSONObject().put("id", "1").put("number", "1").put("title", "Глава 1").put("origin", origin).put("available", true))).put("chapterKeys", new JSONArray().put(key())).put("cachedChapterKeys", cached ? new JSONArray().put(key()) : new JSONArray()).put("branches", new JSONArray()).put("downloadBranchId", ""));
        return new JSONObject().put("format", "gargantua-catalog").put("schemaVersion", 1).put("name", "Мой каталог").put("createdAt", "2026-10-24T00:00:00Z").put("books", books).put("chapterCount", editions).put("cachedChapterCount", cached ? editions : 0).put("server", "https://private.invalid");
    }
    private File folder() throws Exception { return Files.createTempDirectory("gargantua-catalog-unit-").toFile(); }
    private LinkedHashMap<String, byte[]> unzip(File file) throws Exception { LinkedHashMap<String, byte[]> data = new LinkedHashMap<>(); try (ZipInputStream input = new ZipInputStream(new FileInputStream(file))) { ZipEntry entry; while ((entry = input.getNextEntry()) != null) { ByteArrayOutputStream output = new ByteArrayOutputStream(); CatalogArchive.copy(input, output, 8 * 1024 * 1024); data.put(entry.getName(), output.toByteArray()); } } return data; }
    private byte[] zip(Map<String, byte[]> data) throws Exception { ByteArrayOutputStream out = new ByteArrayOutputStream(); try (ZipOutputStream zip = new ZipOutputStream(out)) { for (Map.Entry<String, byte[]> row : data.entrySet()) { zip.putNextEntry(new ZipEntry(row.getKey())); zip.write(row.getValue()); zip.closeEntry(); } } return out.toByteArray(); }
    private CatalogArchive.Exported export(int editions) throws Exception { byte[] value = content().toString().getBytes(StandardCharsets.UTF_8); return CatalogArchive.exportZip(manifest(editions, true), folder(), key -> value); }
    @Test public void roundTripKeepsBookOrderAndChapterTextWithoutConnectionMetadata() throws Exception {
        CatalogArchive.Exported exported = export(2); CatalogArchive.Prepared imported = CatalogArchive.readZip(new FileInputStream(exported.file), folder());
        assertEquals("edition-0", imported.manifest.getJSONArray("books").getJSONObject(0).getJSONObject("book").getString("id"));
        assertEquals("edition-1", imported.manifest.getJSONArray("books").getJSONObject(1).getJSONObject("book").getString("id"));
        assertEquals(2, imported.manifest.getInt("chapterCount")); assertEquals(2, imported.manifest.getInt("cachedChapterCount")); assertEquals(1, imported.chapters.size());
        assertEquals(CatalogArchive.canonical(content()), CatalogArchive.canonical(CatalogArchive.parse(CatalogArchive.chapterBytes(imported.chapters.get(key())), CatalogArchive.MAX_CHAPTER)));
        assertFalse(imported.manifest.toString().contains("private.invalid")); assertFalse(imported.manifest.toString().contains("should-not-export"));
    }
    @Test public void crossBookSharedOriginsUseOneFileAndLogicalCountsStayAccurate() throws Exception {
        CatalogArchive.Exported exported = export(3); assertEquals(1, exported.manifest.getJSONArray("entries").length()); assertEquals(3, exported.manifest.getInt("cachedChapterCount")); assertEquals(1, exported.manifest.getInt("uniqueCachedChapterCount"));
        assertEquals(2, unzip(exported.file).size());
    }
    @Test public void partialCatalogReportsActualNativeCacheRatherThanAssumingManifestSuccess() throws Exception {
        CatalogArchive.Exported exported = CatalogArchive.exportZip(manifest(1, true), folder(), key -> null);
        assertEquals(0, exported.manifest.getInt("cachedChapterCount")); assertTrue(exported.manifest.getBoolean("partial"));
        CatalogArchive.Prepared imported = CatalogArchive.readZip(new FileInputStream(exported.file), folder()); assertTrue(imported.chapters.isEmpty()); assertEquals(1, imported.manifest.getInt("chapterCount"));
    }
    @Test public void modifiedChapterHashIsRejectedBeforeAnyCacheInterfaceExists() throws Exception {
        Map<String, byte[]> data = unzip(export(1).file); data.put("chapters/000001.json", new JSONObject().put("paragraphs", new JSONArray().put("Подмена текста")).toString().getBytes(StandardCharsets.UTF_8));
        assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.readZip(new ByteArrayInputStream(zip(data)), folder()));
    }
    @Test public void missingAndUnexpectedChapterFilesAreRejected() throws Exception {
        Map<String, byte[]> missing = unzip(export(1).file); missing.remove("chapters/000001.json");
        assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.readZip(new ByteArrayInputStream(zip(missing)), folder()));
        Map<String, byte[]> extra = unzip(export(1).file); extra.put("chapters/000002.json", "{}".getBytes(StandardCharsets.UTF_8));
        assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.readZip(new ByteArrayInputStream(zip(extra)), folder()));
    }
    @Test public void traversalAndForeignEntriesNeverBecomeFilesystemPaths() throws Exception {
        for (String path : new String[]{"../outside.json", "/absolute.json", "chapters/../outside.json", "chapters\\000001.json", "preferences.json"}) {
            Map<String, byte[]> data = unzip(export(1).file); data.put(path, "{}".getBytes(StandardCharsets.UTF_8));
            assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.readZip(new ByteArrayInputStream(zip(data)), folder()));
        }
    }
    @Test public void duplicateZipNamesAreRejectedEvenWithOtherwiseValidBytes() throws Exception {
        Map<String, byte[]> data = unzip(export(1).file); data.put("catalog.jsoX", data.get("catalog.json")); byte[] archive = zip(data), from = "catalog.jsoX".getBytes(StandardCharsets.UTF_8), to = "catalog.json".getBytes(StandardCharsets.UTF_8);
        for (int i = 0; i <= archive.length - from.length; i++) { boolean match = true; for (int j = 0; j < from.length; j++) if (archive[i + j] != from[j]) { match = false; break; } if (match) System.arraycopy(to, 0, archive, i, to.length); }
        assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.readZip(new ByteArrayInputStream(archive), folder()));
    }
    @Test public void entryMetadataCannotClaimDifferentLogicalCountOrChapterIdentity() throws Exception {
        JSONObject wrong = manifest(1, true).put("chapterCount", 2); assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.normalize(wrong));
        JSONObject forged = manifest(1, true); forged.getJSONArray("books").getJSONObject(0).getJSONArray("chapterKeys").put(0, "forged"); assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.normalize(forged));
        JSONObject tooMany = manifest(1, true); JSONArray books = tooMany.getJSONArray("books"); for (int i = 1; i < 1001; i++) books.put(books.getJSONObject(0)); assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.normalize(tooMany));
    }
    @Test public void jsonMustBeBoundedUtf8AndCanonicalComparisonPreservesTextMeaning() throws Exception {
        assertThrows(Exception.class, () -> CatalogArchive.parse(new byte[]{(byte) 0xc3, 0x28}, 100));
        assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.parse("{} trailing".getBytes(StandardCharsets.UTF_8), 100));
        assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.parse("{}".getBytes(StandardCharsets.UTF_8), 1));
        assertEquals(CatalogArchive.canonical(new JSONObject("{\"b\":2,\"a\":\"text\"}")), CatalogArchive.canonical(new JSONObject(" { \"a\" : \"text\", \"b\" : 2 } ")));
        assertNotEquals(CatalogArchive.canonical(new JSONObject().put("text", "a")), CatalogArchive.canonical(new JSONObject().put("text", " a")));
    }
    @Test public void duplicateBookIdentityAndUnknownSourcesAreRejectedBeforePreparation() throws Exception {
        JSONObject duplicate = manifest(2, true); duplicate.getJSONArray("books").getJSONObject(1).getJSONObject("book").put("id", "edition-0");
        assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.normalize(duplicate));
        JSONObject unknown = manifest(1, true); unknown.getJSONArray("books").getJSONObject(0).getJSONObject("book").put("source", "unknown-server");
        assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.normalize(unknown));
        JSONObject badId = manifest(1, true); badId.getJSONArray("books").getJSONObject(0).getJSONObject("book").put("id", "https://private.invalid/book");
        assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.normalize(badId));
    }
    @Test public void unsafeOriginsCannotReachPreparedCacheFiles() throws Exception {
        for (String value : new String[]{"https://private.invalid/chapter", "line\nbreak", "bad\u007fcontrol"}) {
            JSONObject input = manifest(1, true), row = input.getJSONArray("books").getJSONObject(0), origin = row.getJSONArray("chapters").getJSONObject(0).getJSONObject("origin"); origin.put("chapterId", value);
            row.getJSONArray("chapterKeys").put(0, DownloadProtocol.key(origin)); row.getJSONArray("cachedChapterKeys").put(0, DownloadProtocol.key(origin));
            assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.normalize(input));
        }
    }
    @Test public void streamLimitCannotBeBypassedByZipMetadataOrAChunkedInput() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        assertThrows(CatalogArchive.Invalid.class, () -> CatalogArchive.copy(new ByteArrayInputStream(new byte[1025]), output, 1024));
        assertEquals(0, output.size());
    }
    @Test public void metadataNormalizesUnicodeSpacesWithAndroidCompatiblePatterns() throws Exception {
        JSONObject input = manifest(1, true).put("name", "\u00a0\uFEFFМой\u202f\u2003каталог\u3000");
        input.getJSONArray("books").getJSONObject(0).getJSONObject("book").put("title", "\u2028Книга\u00a0\u00a0для\u2009чтения\u2029");
        JSONObject safe = CatalogArchive.normalize(input);
        assertEquals("Мой каталог", safe.getString("name"));
        assertEquals("Книга для чтения", safe.getJSONArray("books").getJSONObject(0).getJSONObject("book").getString("title"));
    }
}
