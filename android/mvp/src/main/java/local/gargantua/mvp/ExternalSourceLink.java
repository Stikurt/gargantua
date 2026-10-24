package local.gargantua.mvp;

import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** Public book pages may open in a browser; they never navigate the reader WebView. */
final class ExternalSourceLink {
    private static final Set<String> HOSTS = new HashSet<>(Arrays.asList(
        "ranobelib.me", "www.gutenberg.org", "gutenberg.org", "ru.wikisource.org",
        "litlife.club", "libcat.ru", "ranobe.me", "ranobehub.org"
    ));

    static String validate(String raw) {
        if (raw == null || raw.length() > 8192 || raw.chars().anyMatch(c -> c < 32 || c == 127)) return null;
        try {
            URI uri = URI.create(raw);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || !HOSTS.contains(uri.getHost().toLowerCase(Locale.ROOT))
                    || uri.getRawUserInfo() != null || uri.getPort() != -1 && uri.getPort() != 443) return null;
            return uri.toASCIIString();
        } catch (RuntimeException invalid) { return null; }
    }
}
