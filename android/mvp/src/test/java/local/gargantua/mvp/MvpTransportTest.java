package local.gargantua.mvp;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class MvpTransportTest {
    @Test public void preservesJsonSuccessAndErrorMetadata() throws Exception {
        JSONObject success = MvpTransport.result("{\"items\":[{\"title\":\"Король в жёлтом\"}]}", 200, null);
        assertEquals("Король в жёлтом", success.getJSONArray("items").getJSONObject(0).getString("title"));
        JSONObject failure = MvpTransport.result("{\"error\":\"Пауза\",\"code\":\"SOURCE_RATE_LIMIT\",\"retryAfterMs\":3210}", 429, "30");
        assertEquals(429, failure.getInt("status"));
        assertEquals("SOURCE_RATE_LIMIT", failure.getString("code"));
        assertEquals(3210, failure.getInt("retryAfterMs"));
    }
    @Test public void acceptsRetryAfterHeaderAndRejectsNonJsonOrInvalidRetry() throws Exception {
        JSONObject failure = MvpTransport.result("{\"error\":\"Пауза\"}", 429, "2.5");
        assertEquals(2500, failure.getLong("retryAfterMs"));
        assertEquals("SOURCE_FORMAT", MvpTransport.result("<html>bad</html>", 200, null).getString("code"));
        assertEquals("SOURCE_FORMAT", MvpTransport.result("[]", 502, null).getString("code"));
        assertEquals(-1, MvpTransport.retryAfter("-3", 0));
        assertEquals(-1, MvpTransport.retryAfter("NaN", 0));
        assertEquals(-1, MvpTransport.retryAfter("nonsense", 0));
        assertEquals(604800000, MvpTransport.retryAfter("999999999", 0));
        assertEquals(1000, MvpTransport.retryAfter("Thu, 01 Jan 1970 00:00:01 GMT", 0));
    }
    @Test public void offlineAndInvalidRequestsNeverOpenNetwork() throws Exception {
        assertEquals("SERVER_OFFLINE", MvpTransport.request("https://unused.invalid", "/api/mvp/search?q=%D0%9A", true).getString("code"));
        assertEquals(0, MvpTransport.request("", "/api/mvp/health", false).getInt("status"));
        JSONObject failure = MvpTransport.request("https://unused.invalid", "https://evil.invalid/api/mvp/health", false);
        assertEquals(400, failure.getInt("status"));
        assertEquals("REQUEST_INVALID", failure.getString("code"));
    }
}
