package local.gargantua.mvp;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class DownloadProtocolTest {
    private JSONObject origin(String source, String chapter) throws Exception { return new JSONObject().put("source", source).put("bookId", "Верховный Маг / том 1").put("branchId", "ветка").put("chapterId", chapter); }
    private JSONObject item(String source, String chapter) throws Exception { JSONObject origin = origin(source, chapter); return new JSONObject().put("key", DownloadProtocol.key(origin)).put("origin", origin).put("chapter", new JSONObject().put("id", chapter).put("title", "Глава " + chapter)).put("status", "pending"); }
    private JSONObject job(int count) throws Exception {
        JSONArray items = new JSONArray(); for (int i = 1; i <= count; i++) items.put(item(i <= 1164 ? "ranobelib" : "ranobeme", String.valueOf(i)));
        return new JSONObject().put("id", "test-download").put("outlineKey", "outline-" + count).put("book", new JSONObject().put("source", "merged").put("id", "merged-id").put("title", "Верховный Маг")).put("items", items).put("status", "queued");
    }
    @Test public void completeMergedOutlineExceedsOldBridgeLimitWithoutTruncation() throws Exception {
        JSONObject input = job(4531); assertTrue(input.toString().length() > 16384);
        JSONObject safe = DownloadProtocol.job(input);
        assertEquals(4531, safe.getJSONArray("items").length());
        assertEquals("ranobelib", safe.getJSONArray("items").getJSONObject(1163).getJSONObject("origin").getString("source"));
        assertEquals("ranobeme", safe.getJSONArray("items").getJSONObject(4530).getJSONObject("origin").getString("source"));
        assertEquals("4531", safe.getJSONArray("items").getJSONObject(4530).getJSONObject("origin").getString("chapterId"));
    }
    @Test public void sourceAndBranchArePartOfDurableChapterIdentity() throws Exception {
        JSONObject first = origin("ranobelib", "10"), other = origin("ranobeme", "10");
        assertNotEquals(DownloadProtocol.key(first), DownloadProtocol.key(other));
        String key = DownloadProtocol.key(first);
        assertEquals("[\"ranobelib\",\"Верховный Маг / том 1\",\"ветка\",\"10\"]", key);
        assertEquals(key, DownloadProtocol.validateKey(key));
        first.put("branchId", "другая"); assertNotEquals(key, DownloadProtocol.key(first));
    }
    @Test public void chapterRequestRetainsCyrillicAndCannotSelectAnotherRoute() throws Exception {
        String path = DownloadProtocol.chapterPath(origin("wikisource", "Король в жёлтом?x=1#fragment"));
        assertTrue(path.startsWith("/api/mvp/chapter?source=wikisource&id="));
        assertTrue(path.contains("%D0%92")); assertTrue(path.contains("%3Fx%3D1%23fragment")); assertFalse(path.contains(" "));
        assertEquals(path, ServerAddress.apiPath(path));
        assertThrows(IllegalArgumentException.class, () -> DownloadProtocol.chapterPath(origin("https://evil.invalid", "1")));
        assertThrows(IllegalArgumentException.class, () -> DownloadProtocol.chapterPath(origin("merged", "1")));
    }
    @Test public void forgedOrDuplicateKeysAreRejectedBeforePersistence() throws Exception {
        JSONObject forged = job(1); forged.getJSONArray("items").getJSONObject(0).put("key", "arbitrary-local-key");
        assertThrows(IllegalArgumentException.class, () -> DownloadProtocol.job(forged));
        JSONObject duplicate = job(1); duplicate.getJSONArray("items").put(duplicate.getJSONArray("items").getJSONObject(0));
        assertThrows(IllegalArgumentException.class, () -> DownloadProtocol.job(duplicate));
        assertThrows(IllegalArgumentException.class, () -> DownloadProtocol.validateKey("[\"ranobelib\",\"x\",\"\",\"1\",\"extra\"]"));
    }
    @Test public void emptyOrExcessiveManifestAndDescriptorsFailClearly() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> DownloadProtocol.job(job(0)));
        JSONObject tooLarge = job(1); tooLarge.getJSONObject("book").put("extra", "x".repeat(300000));
        assertThrows(IllegalArgumentException.class, () -> DownloadProtocol.job(tooLarge));
    }
    @Test public void emptyOrErrorChapterCannotCountAsDownloaded() throws Exception {
        assertFalse(DownloadProtocol.hasText(null));
        assertFalse(DownloadProtocol.hasText(new JSONObject().put("paragraphs", new JSONArray().put(" ").put(""))));
        assertFalse(DownloadProtocol.hasText(new JSONObject().put("error", "Unavailable").put("text", "not a success")));
        assertTrue(DownloadProtocol.hasText(new JSONObject().put("paragraphs", new JSONArray().put("Сохранённый русский текст"))));
        assertTrue(DownloadProtocol.hasText(new JSONObject().put("text", "Текст")));
    }
    @Test public void serverRateLimitHonorsRetryAfterWithBoundedFallback() throws Exception {
        JSONObject limited = MvpTransport.error("Wait", 429, "SOURCE_RATE_LIMIT").put("retryAfterMs", 123456);
        assertTrue(DownloadProtocol.rateLimited(limited)); assertEquals(123456, DownloadProtocol.retryDelay(limited, 1));
        limited.put("retryAfterMs", 0); assertEquals(1000, DownloadProtocol.retryDelay(limited, 1));
        limited.remove("retryAfterMs"); assertEquals(60000, DownloadProtocol.retryDelay(limited, 20));
        limited.put("retryAfterMs", 999999999L); assertEquals(604800000, DownloadProtocol.retryDelay(limited, 1));
    }
    @Test public void connectionFailureRetriesAndExplicitPauseIsNeverRunnable() throws Exception {
        JSONObject offline = MvpTransport.error("Offline", 0, "SERVER_OFFLINE");
        assertTrue(DownloadProtocol.networkError(offline)); assertEquals(30000, DownloadProtocol.retryDelay(offline, 1)); assertEquals(300000, DownloadProtocol.retryDelay(offline, 10));
        assertFalse(DownloadProtocol.networkError(MvpTransport.error("Restricted", 403, "SOURCE_RESTRICTED")));
        for (String status : new String[]{"paused", "error", "partial", "complete"}) assertFalse(DownloadProtocol.runnable(status));
        for (String status : new String[]{"queued", "downloading", "waiting"}) assertTrue(DownloadProtocol.runnable(status));
    }
}
