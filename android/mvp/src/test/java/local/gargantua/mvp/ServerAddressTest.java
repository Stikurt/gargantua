package local.gargantua.mvp;

import org.junit.Test;
import static org.junit.Assert.*;

public class ServerAddressTest {
    @Test public void acceptsHttpsAndPrivateLanIncludingUsbEmulator() {
        assertEquals("https://books.example.org", ServerAddress.validate(" https://BOOKS.example.org/ "));
        assertEquals("https://pc.user.ts.net", ServerAddress.validate("https://pc.user.ts.net"));
        for (String host : new String[]{"127.0.0.1", "localhost", "10.0.2.2", "192.168.1.12", "172.16.0.1", "172.31.255.254", "100.64.0.1", "reader.local", "[::1]"}) {
            assertEquals("http://" + host + ":3080", ServerAddress.validate("http://" + host + ":3080/"));
        }
    }
    @Test public void rejectsCredentialsPathsFragmentsPublicCleartextAndInvalidIpv4() {
        for (String value : new String[]{"", "http://example.org", "http://8.8.8.8", "http://192.168.1.999", "http://192.168.01.1", "http://172.15.1.1", "http://172.32.1.1", "http://100.128.0.1", "http://user:secret@127.0.0.1", "https://example.org/api", "https://example.org/?q=x", "https://example.org/#x", "https://example.org:0", "https://example.org:65536", "file:///tmp/server", "https://example.org\\@127.0.0.1"}) {
            try { ServerAddress.validate(value); fail(value); } catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void preservesRussianQueriesAndAllWhitelistedMvpEndpoints() {
        String query = "/api/mvp/search?q=%D0%9A%D0%BE%D1%80%D0%BE%D0%BB%D1%8C+%D0%B2+%D0%B6%D1%91%D0%BB%D1%82%D0%BE%D0%BC&source=all&page=1";
        assertEquals(query, ServerAddress.apiPath(query));
        for (String route : new String[]{"health", "sources", "search", "random", "book", "chapter", "related", "merge"}) assertEquals("/api/mvp/" + route, ServerAddress.apiPath("/api/mvp/" + route));
        assertTrue(ServerAddress.apiPath("/api/mvp/search?q=Король").contains("%D0%9A"));
        assertEquals("/api/mvp/book?id=https%3A%2F%2Fexample.org%2Ffoo", ServerAddress.apiPath("/api/mvp/book?id=https%3A%2F%2Fexample.org%2Ffoo"));
    }
    @Test public void preventsOtherOriginsAndEncodedOrTraversalEndpoints() {
        for (String path : new String[]{"https://evil.org/api/mvp/search", "//evil.org/api/mvp/search", "/api/audio", "/api/mvp/search/../chapter", "/api/mvp/%63hapter", "/api/mvp/search%3Fq=x", "/api/mvp/search#fragment", "/api/mvp/search?q=%", "/api/mvp/search\\x", "/api/mvp/search\n", "/api/mvp/search/", "/api/mvp/chapter-extra"}) {
            try { ServerAddress.apiPath(path); fail(path); } catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void choosesTimeoutFromEndpointNotQuery() {
        assertEquals(3000, ServerAddress.timeout("/api/mvp/health?related=1"));
        assertEquals(90000, ServerAddress.timeout("/api/mvp/related?id=123"));
        assertEquals(65000, ServerAddress.timeout("/api/mvp/chapter?id=health"));
    }
}
