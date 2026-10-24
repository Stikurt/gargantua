package local.gargantua.mvp;

import java.net.URI;
import java.util.Locale;
import java.util.Set;
import java.util.Arrays;
import java.util.HashSet;

/** Only the configured origin and a small GET-only API surface are reachable. */
final class ServerAddress {
    private static final Set<String> ROUTES = new HashSet<>(Arrays.asList("health", "sources", "search", "random", "book", "chapter", "related", "merge"));

    static String validate(String raw) {
        try {
            if (raw == null || raw.length() > 2048) throw new IllegalArgumentException();
            URI uri = URI.create(raw.trim());
            String host = uri.getHost();
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (host == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || !(uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))
                    || uri.getPort() == 0 || uri.getPort() > 65535
                    || !(scheme.equals("https") || scheme.equals("http") && isLocalHost(host))) throw new IllegalArgumentException();
            host = host.toLowerCase(Locale.ROOT);
            return scheme + "://" + host + (uri.getPort() == -1 ? "" : ":" + uri.getPort());
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("Введите HTTPS-адрес сервера или HTTP-адрес ПК в локальной сети, без пути и пароля.");
        }
    }

    static boolean isLocalHost(String value) {
        String host = value.toLowerCase(Locale.ROOT);
        if (host.equals("localhost") || host.equals("[::1]")) return true;
        if (host.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.local")) return true;
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] bytes = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("0|[1-9][0-9]{0,2}")) return false;
            bytes[i] = Integer.parseInt(parts[i]);
            if (bytes[i] > 255) return false;
        }
        return bytes[0] == 10 || bytes[0] == 127 || bytes[0] == 192 && bytes[1] == 168
                || bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31
                || bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127;
    }

    static String apiPath(String path) {
        try {
            if (path == null || path.length() > 8192 || path.indexOf('\\') >= 0 || path.chars().anyMatch(c -> c < 32 || c == 127)) throw new IllegalArgumentException();
            URI uri = URI.create(path);
            String prefix = "/api/mvp/";
            if (uri.isAbsolute() || uri.getRawAuthority() != null || uri.getRawFragment() != null
                    || !uri.getRawPath().startsWith(prefix) || !ROUTES.contains(uri.getRawPath().substring(prefix.length()))) throw new IllegalArgumentException();
            // Keep URLSearchParams percent encoding intact: Russian queries are valid.
            // A query can never change the validated origin or endpoint path.
            return uri.toASCIIString();
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("Недопустимый запрос к серверу.");
        }
    }

    static int timeout(String path) {
        String route = URI.create(path).getPath();
        return route.endsWith("/health") ? 3000 : route.endsWith("/related") ? 90000 : 65000;
    }
}
