package local.cotology.reader;

import android.content.Context;
import android.util.Base64;
import org.json.*;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

/** Read-only access to the existing encrypted login; no cookies are exposed to the page or player. */
final class AudioSession implements AudioLibrary.Fetcher {
    private final Context context;
    private final java.util.Map<Thread,HttpURLConnection> connections=new java.util.concurrent.ConcurrentHashMap<>();
    AudioSession(Context context){this.context=context.getApplicationContext();}
    static void server(Context context,String server){context.getSharedPreferences("audio-session",0).edit().putString("server",server).apply();}
    public String currentServer(){String server=context.getSharedPreferences("audio-session",0).getString("server","");return server.isEmpty()?"":ServerAddress.validate(server);}
    private String cookie() throws Exception {
        JSONObject envelope=new JSONObject(new String(AudioStore.read(new File(context.getFilesDir(),"session.enc"),16384),StandardCharsets.UTF_8));KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);if(!keys.containsAlias("cotology-session"))throw new IOException("Войдите на сервер");SecretKey key=(SecretKey)keys.getKey("cotology-session",null);
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key,new GCMParameterSpec(128,Base64.decode(envelope.getString("iv"),Base64.NO_WRAP)));String cookie=new String(cipher.doFinal(Base64.decode(envelope.getString("data"),Base64.NO_WRAP)),StandardCharsets.UTF_8);if(!cookie.matches("cotology=[a-zA-Z0-9._-]{1,1024}"))throw new IOException("Войдите на сервер");return cookie;
    }
    public AudioLibrary.Response fetch(String server,String path,int max) throws Exception {
        if(!ServerAddress.validate(server).equals(currentServer()))throw new IOException("Подключён другой сервер");ServerAddress.apiPath(path);HttpURLConnection c=(HttpURLConnection)new URL(server+path).openConnection();String session=cookie();Thread thread=Thread.currentThread();connections.put(thread,c);
        try{c.setRequestMethod("GET");c.setInstanceFollowRedirects(false);c.setConnectTimeout(15000);c.setReadTimeout(30000);c.setRequestProperty("Cookie",session);c.setRequestProperty("X-Cotology","1");c.setRequestProperty("Accept-Encoding","identity");int status=c.getResponseCode();if(status==429||status==503){long retry=status==429?60000:2000;try{retry=Long.parseLong(c.getHeaderField("Retry-After"))*1000;}catch(Exception ignored){}throw new AudioLibrary.RetryLater(retry);}if(status!=200)throw new IOException(status==401||status==403?"Войдите в исходный профиль":"Сервер не передал аудио ("+status+")");long expected=c.getContentLengthLong();if(expected>max)throw new IOException("Ответ превышает допустимый размер");byte[] bytes;try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] buffer=new byte[16384];int n;while((n=in.read(buffer))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Скачивание остановлено");if(out.size()+n>max)throw new IOException("Ответ слишком большой");out.write(buffer,0,n);}bytes=out.toByteArray();}if(expected>=0&&expected!=bytes.length)throw new IOException("Ответ оборван");String sha=c.getHeaderField("X-Content-SHA256");if(path.contains("/derived/")&&(sha==null||!AudioStore.checksum(sha).equals(AudioStore.hash(bytes))))throw new IOException("Ответ не прошёл SHA-256");return new AudioLibrary.Response(bytes,sha,AudioStore.hash(session.getBytes(StandardCharsets.UTF_8)));
        }catch(java.net.SocketTimeoutException|java.net.SocketException|java.net.UnknownHostException|java.io.EOFException transientFailure){throw new AudioLibrary.RetryLater(2000);}finally{connections.remove(thread,c);c.disconnect();}
    }
    @Override public void cancel(Thread thread){if(thread!=null){HttpURLConnection c=connections.get(thread);if(c!=null)c.disconnect();}}
}
