package local.gargantua.mvp;

import org.junit.Test;
import static org.junit.Assert.*;

public class ExternalSourceLinkTest {
    @Test public void acceptsOnlyRealProviderOriginsAndPreservesPublicBookPaths() {
        for (String url : new String[]{
            "https://ranobelib.me/ru/book/38728--supreme-magus",
            "https://www.gutenberg.org/ebooks/8492", "https://gutenberg.org/ebooks/8492",
            "https://ru.wikisource.org/wiki/Король_в_жёлтом",
            "https://litlife.club/books/11593/read", "https://libcat.ru/knigi/430898-robert-chambers-korol-v-zheltom.html",
            "https://ranobe.me/ranobe297", "https://ranobehub.org/book/964-supreme-magus"
        }) {
            String accepted = ExternalSourceLink.validate(url);
            assertNotNull(url, accepted);
            assertTrue(accepted.startsWith("https://"));
        }
        assertEquals("https://LIBCAT.RU:443/book?q=%D0%9A#chapter", ExternalSourceLink.validate("https://LIBCAT.RU:443/book?q=%D0%9A#chapter"));
    }

    @Test public void rejectsCredentialsAndHostOrSchemeSubstitution() {
        for (String url : new String[]{
            "https://libcat.ru.evil.example/book", "https://evil.example/libcat.ru", "https://libcat.ru@evil.example/book",
            "https://user:secret@libcat.ru/book", "https://evil.example@libcat.ru/book", "https://libcat.ru:444/book",
            "http://libcat.ru/book", "javascript:alert(1)", "intent://libcat.ru/book", "file:///book",
            "https://127.0.0.1/book", "https://appassets.androidplatform.net/index.html", "//libcat.ru/book",
            "https://libcat.ru\\@evil.example/book", "https://libcat.ru/book\n", "https://%6cibcat.ru/book", "https://libcat.ru/%"
        }) assertNull(url, ExternalSourceLink.validate(url));
        assertNull(ExternalSourceLink.validate(null));
        assertNull(ExternalSourceLink.validate(""));
    }
}
