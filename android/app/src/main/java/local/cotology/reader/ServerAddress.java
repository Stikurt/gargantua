package local.cotology.reader;
import java.net.URI;
final class ServerAddress {
    static String validate(String raw) {
        URI uri=URI.create(raw.trim());String host=uri.getHost();
        if(!"https".equals(uri.getScheme())||host==null||!host.matches("[a-z0-9-]+\\.[a-z0-9-]+\\.ts\\.net")||uri.getUserInfo()!=null||uri.getPort()!=-1||uri.getRawQuery()!=null||uri.getRawFragment()!=null||!(uri.getRawPath().isEmpty()||uri.getRawPath().equals("/")))throw new IllegalArgumentException("Нужен адрес https://имя-пк.имя-сети.ts.net без пути и порта");
        return "https://"+host;
    }
    static String apiPath(String path) {
        URI uri=URI.create(path);
        if(uri.isAbsolute()||uri.getRawAuthority()!=null||!path.startsWith("/api/")||path.contains("\\")||path.contains("..")||path.contains("%")||uri.getRawFragment()!=null)throw new IllegalArgumentException("Недопустимый путь API");
        return path;
    }
}
