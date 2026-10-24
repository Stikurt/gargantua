package local.gargantua.mvp;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;

/** The Activity and foreground worker use one durable connection configuration. */
final class MvpConnection {
    static synchronized SharedPreferences preferences(Context context) {
        SharedPreferences values = context.getApplicationContext().getSharedPreferences("gargantua-connection", Context.MODE_PRIVATE);
        boolean migrated = values.getBoolean("migrated", false);
        if (!migrated || values.getString("server", "").isEmpty()) {
            // getPreferences uses the FQN in a debug applicationId whose suffix
            // differs from the Activity Java package, and the short name in release.
            SharedPreferences old = context.getApplicationContext().getSharedPreferences(MainActivity.class.getName(), Context.MODE_PRIVATE);
            String server = old.getString("server", "");
            if (server.isEmpty()) { old = context.getApplicationContext().getSharedPreferences("MainActivity", Context.MODE_PRIVATE); server = old.getString("server", ""); }
            if (!server.isEmpty()) { try { server = ServerAddress.validate(server); } catch (IllegalArgumentException invalid) { server = ""; } }
            SharedPreferences.Editor edit = values.edit().putBoolean("migrated", true);
            if (!server.isEmpty()) edit.putString("server", server);
            if (!migrated) edit.putBoolean("debug-offline", old.getBoolean("debug-offline", false)).putString("debug-test-session", old.getString("debug-test-session", ""));
            if (!edit.commit()) throw new IllegalStateException("Не удалось сохранить настройки подключения.");
        }
        return values;
    }
    static String server(Context context) { return preferences(context).getString("server", ""); }
    static boolean offline(Context context) { return BuildConfig.DEBUG && preferences(context).getBoolean("debug-offline", false); }
    static String session(Context context) { return BuildConfig.DEBUG ? preferences(context).getString("debug-test-session", "") : ""; }
    static JSONObject info(Context context) throws Exception { String server = server(context); return new JSONObject().put("server", server).put("configured", !server.isEmpty()).put("offline", offline(context)); }
}
