package local.gargantua.mvp;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;

final class MvpTransport {
    static final int MAX_BYTES = 24 * 1024 * 1024;

    static JSONObject error(String message, int status, String code) {
        JSONObject result = new JSONObject();
        try { result.put("error", message).put("status", status).put("code", code); } catch (Exception ignored) { }
        return result;
    }

    static long retryAfter(String header, long now) {
        if (header == null || header.trim().isEmpty()) return -1;
        try { double seconds = Double.parseDouble(header.trim()); return Double.isFinite(seconds) && seconds >= 0 ? Math.min(86400000, (long) Math.ceil(seconds * 1000)) : -1; }
        catch (NumberFormatException ignored) {
            try { return Math.min(86400000, Math.max(0, ZonedDateTime.parse(header.trim(), DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() - now)); }
            catch (RuntimeException invalid) { return -1; }
        }
    }

    static JSONObject result(String text, int status, String retryHeader) {
        try {
            JSONObject value = new JSONObject(text);
            if (status >= 200 && status < 300) return value;
            JSONObject failure = error(value.optString("error", "Ошибка сервера (" + status + ")"), status, value.optString("code", "SOURCE_ERROR"));
            double retry = value.optDouble("retryAfterMs", Double.NaN);
            if (Double.isFinite(retry) && retry >= 0) failure.put("retryAfterMs", retry);
            else { long millis = retryAfter(retryHeader, System.currentTimeMillis()); if (millis >= 0) failure.put("retryAfterMs", millis); }
            return failure;
        } catch (Exception invalid) { return error("Сервер вернул некорректный ответ.", status >= 400 ? status : 502, "SOURCE_FORMAT"); }
    }

    static JSONObject request(String server, String rawPath, boolean offline) {
        final String path;
        try { path = ServerAddress.apiPath(rawPath); }
        catch (IllegalArgumentException error) { return error(error.getMessage(), 400, "REQUEST_INVALID"); }
        if (offline || server == null || server.isEmpty()) return error("Нет связи с сервером. Сохранённые главы доступны без интернета.", 0, "SERVER_OFFLINE");
        HttpURLConnection connection = null;
        long deadline = System.nanoTime() + ServerAddress.timeout(path) * 1000000L;
        try {
            String origin = ServerAddress.validate(server);
            connection = (HttpURLConnection) new URL(origin + path).openConnection();
            connection.setRequestMethod("GET");
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(Math.min(15000, ServerAddress.timeout(path)));
            connection.setReadTimeout(ServerAddress.timeout(path));
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("X-Cotology", "1");
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) return error("Сервер перенаправил запрос. Проверьте адрес сервера.", status, "SOURCE_REDIRECT");
            if (connection.getContentLengthLong() > MAX_BYTES) return error("Ответ источника слишком большой.", 502, "SOURCE_LIMIT");
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream == null) return error("Сервер вернул пустой ответ.", status >= 400 ? status : 502, "SOURCE_FORMAT");
            try (InputStream input = stream; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[16384]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (System.nanoTime() > deadline) throw new SocketTimeoutException();
                    if (out.size() + count > MAX_BYTES) return error("Ответ источника слишком большой.", 502, "SOURCE_LIMIT");
                    out.write(buffer, 0, count);
                    long remaining = (deadline - System.nanoTime()) / 1000000L;
                    if (remaining <= 0) throw new SocketTimeoutException();
                    connection.setReadTimeout((int) Math.max(1, remaining));
                }
                return result(new String(out.toByteArray(), StandardCharsets.UTF_8), status, connection.getHeaderField("Retry-After"));
            }
        } catch (SocketTimeoutException timeout) { return error("Источник не ответил вовремя. Повторите запрос.", 0, "SOURCE_TIMEOUT"); }
        catch (Exception unavailable) { return error("Сервер недоступен. Проверьте адрес и подключение.", 0, "SERVER_OFFLINE"); }
        finally { if (connection != null) connection.disconnect(); }
    }
}
