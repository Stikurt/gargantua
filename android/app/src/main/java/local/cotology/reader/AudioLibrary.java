package local.cotology.reader;

import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.*;

/** Device-wide audio catalogue. Each immutable namespace includes its original server and profile. */
final class AudioLibrary {
    interface Fetcher { Response fetch(String server,String path,int max) throws Exception; String currentServer(); default void cancel(Thread thread){} }
    static final class Response { final byte[] bytes;final String sha256,sessionSha256;Response(byte[] bytes,String sha){this(bytes,sha,null);}Response(byte[] bytes,String sha,String session){this.bytes=bytes;sha256=sha;sessionSha256=session;} }
    static final class RetryLater extends IOException {final long millis;RetryLater(long millis){super("Соединение временно недоступно; повторяем скачивание");this.millis=Math.max(1000,Math.min(60000,millis));}}
    private static final class Grant {final String session;final long at;Grant(String session){this.session=session;at=System.currentTimeMillis();}}
    final File root;
    private final Fetcher fetcher;
    private final ExecutorService downloads=Executors.newSingleThreadExecutor();
    private volatile String downloading="";
    private volatile boolean cancelled=false;
    private volatile Thread downloadThread;
    private final java.util.Map<String,AudioStore> stores=new ConcurrentHashMap<>();
    private final java.util.Map<String,Grant> grants=new ConcurrentHashMap<>();
    private long accountedBytes;
    AudioLibrary(File root,Fetcher fetcher) throws Exception {this.root=root;this.fetcher=fetcher;AudioStore.directory(root);accountedBytes=AudioStore.size(root);JSONArray previous=list();for(int i=0;i<previous.length();i++){JSONObject row=previous.getJSONObject(i);if(row.getString("status").equals("downloading"))store(row.getString("scopeId")).recoverInterrupted(row.getString("profileId"),row.getString("jobId"));}}
    static String scope(String server,String profile) throws Exception {return AudioStore.hash((ServerAddress.validate(server)+"|"+AudioStore.id(profile)).getBytes(StandardCharsets.UTF_8));}
    private File scopeDir(String scope) throws Exception {AudioStore.checksum(scope);File dir=new File(root,scope);if(!dir.isDirectory()||Files.isSymbolicLink(dir.toPath()))throw new IOException("Неизвестная библиотека аудио");return dir;}
    JSONObject scopeInfo(String scope) throws Exception {JSONObject info=new JSONObject(new String(AudioStore.read(new File(scopeDir(scope),"scope.json"),4096),StandardCharsets.UTF_8));if(!scope.equals(scope(info.getString("server"),info.getString("profileId"))))throw new IOException("Повреждена принадлежность аудио");return info;}
    AudioStore store(String scope) throws Exception {scopeInfo(scope);AudioStore cached=stores.get(scope);if(cached!=null)return cached;AudioStore next=new AudioStore(new File(scopeDir(scope),"data"));AudioStore previous=stores.putIfAbsent(scope,next);return previous==null?next:previous;}
    private String profile(String scope) throws Exception {return scopeInfo(scope).getString("profileId");}
    private JSONObject decorate(String scope,JSONObject row) throws Exception {return row==null?null:row.put("scopeId",scope);}
    private String authenticated(String scope) throws Exception {JSONObject info=scopeInfo(scope);if(!info.getString("server").equals(fetcher.currentServer()))throw new IOException("Для скачивания подключите исходный сервер");Grant previous=grants.get(scope);if(previous!=null&&System.currentTimeMillis()-previous.at<10000)return previous.session;Response response=fetcher.fetch(info.getString("server"),"/api/me",32768);JSONObject me=new JSONObject(new String(response.bytes,StandardCharsets.UTF_8));if(!me.getString("id").equals(info.getString("profileId")))throw new IOException("Войдите в исходный профиль для скачивания");grants.put(scope,new Grant(response.sessionSha256));return response.sessionSha256;}
    private Response fetch(String scope,String path,int max) throws Exception {String identity=authenticated(scope);Response response=fetcher.fetch(scopeInfo(scope).getString("server"),path,max);if(!java.util.Objects.equals(identity,response.sessionSha256)){grants.remove(scope);throw new IOException("Профиль изменился во время скачивания");}return response;}
    private Response fetchWithRetry(String scope,String path,int max) throws Exception {for(int attempt=0;;attempt++)try{return fetch(scope,path,max);}catch(RetryLater e){if(attempt>=3)throw e;long end=System.currentTimeMillis()+e.millis;while(System.currentTimeMillis()<end){if(Thread.currentThread().isInterrupted()||Thread.currentThread()==downloadThread&&cancelled)throw new InterruptedException();Thread.sleep(Math.min(250,Math.max(1,end-System.currentTimeMillis())));}}}
    synchronized JSONObject register(JSONObject spec) throws Exception {
        String profile=AudioStore.id(spec.getString("profileId")),job=AudioStore.id(spec.getString("jobId")),server=fetcher.currentServer(),scope=scope(server,profile);
        File dir=new File(root,scope);AudioStore.directory(dir);File info=new File(dir,"scope.json");JSONObject binding=new JSONObject().put("server",server).put("profileId",profile).put("scopeId",scope);if(!info.exists())AudioStore.atomic(info,binding.toString().getBytes(StandardCharsets.UTF_8));else scopeInfo(scope);
        Response response=fetch(scope,"/api/derived/jobs/"+job+"/result",AudioStore.MANIFEST_LIMIT);if(accountedBytes+response.bytes.length+65536>AudioStore.QUOTA)throw new IOException("Хранилище аудио заполнено (8 ГБ)");JSONObject row=decorate(scope,store(scope).register(profile,job,response.bytes,response.sha256,spec.optString("title","Аудиокнига"),spec.optString("author","")));accountedBytes=AudioStore.size(root);return row;
    }
    JSONObject get(String scope,String job) throws Exception {return decorate(scope,store(scope).get(profile(scope),AudioStore.id(job)));}
    JSONArray list() throws Exception {JSONArray all=new JSONArray();File[] scopes=root.listFiles();if(scopes!=null)for(File dir:scopes)if(dir.isDirectory()&&!Files.isSymbolicLink(dir.toPath()))try{String scope=AudioStore.checksum(dir.getName());JSONArray rows=store(scope).list(profile(scope));for(int i=0;i<rows.length();i++){JSONObject row=decorate(scope,rows.getJSONObject(i));row.remove("manifest");all.put(row);}}catch(Exception ignored){}return all;}
    private String key(String scope,String job) throws Exception {AudioStore.checksum(scope);AudioStore.id(job);return scope+":"+job;}
    synchronized JSONObject download(String scope,String job) throws Exception {
        String key=key(scope,job);if(!downloading.isEmpty()){if(downloading.equals(key))return get(scope,job);throw new IOException("Уже скачивается другая аудиокнига");}
        if(!scopeInfo(scope).getString("server").equals(fetcher.currentServer()))throw new IOException("Для скачивания подключите исходный сервер");AudioStore s=store(scope);String profile=profile(scope);JSONObject row=s.require(profile,job);if(row.getInt("totalSegments")>8192||row.getLong("totalBytes")>AudioStore.QUOTA)throw new IOException("Аудиокнига превышает предел скачивания (8 ГБ, 8192 фрагмента)");downloading=key;cancelled=false;s.status(profile,job,"downloading",null);
        downloads.execute(()->{downloadThread=Thread.currentThread();try{fetchWithRetry(scope,"/api/me",32768);JSONArray parts=row.getJSONObject("manifest").getJSONArray("segments");int count=0;long bytes=0;for(int i=0;i<parts.length();i++){if(cancelled)throw new InterruptedException();try{bytes+=s.chunk(profile,job,i).length;}catch(IOException missing){if(cancelled)throw new InterruptedException();String server=scopeInfo(scope).getString("server");if(!server.equals(fetcher.currentServer()))throw new IOException("Подключён другой сервер");long started=System.currentTimeMillis();Response content=fetchWithRetry(scope,AudioStore.segmentPath(job,i),AudioStore.CHUNK_LIMIT);if(content.sha256!=null&&!content.sha256.equals(parts.getJSONObject(i).getString("sha256")))throw new IOException("Контрольная сумма ответа изменилась");putChunk(scope,job,i,content.bytes);bytes+=content.bytes.length;while(System.currentTimeMillis()-started<600){if(cancelled)throw new InterruptedException();Thread.sleep(Math.min(100,Math.max(1,600-(System.currentTimeMillis()-started))));}}count++;s.markDownloaded(profile,job,count,bytes);}s.recount(profile,job,"complete",null);}
            catch(InterruptedException e){try{s.recount(profile,job,"partial",null);}catch(Exception ignored){}}
            catch(Exception e){try{s.recount(profile,job,cancelled?"partial":"error",cancelled?null:e.getMessage());}catch(Exception ignored){}}
            finally{synchronized(AudioLibrary.this){downloading="";cancelled=false;downloadThread=null;}}});return decorate(scope,s.require(profile,job));
    }
    synchronized JSONObject cancel(String scope,String job) throws Exception {if(downloading.equals(key(scope,job))){cancelled=true;fetcher.cancel(downloadThread);}return get(scope,job);}
    synchronized boolean remove(String scope,String job) throws Exception {if(downloading.equals(key(scope,job)))throw new IOException("Сначала остановите скачивание");boolean removed=store(scope).remove(profile(scope),job);accountedBytes=AudioStore.size(root);return removed;}
    Object positionGet(String scope,String job) throws Exception {return store(scope).positionGet(profile(scope),job);}
    JSONObject positionPut(String scope,String job,JSONObject p) throws Exception {return store(scope).positionPut(profile(scope),job,p);}
    byte[] chunk(String scope,String job,int ordinal,boolean fetchMissing) throws Exception {
        AudioStore s=store(scope);String profile=profile(scope);try{return s.chunk(profile,job,ordinal);}catch(IOException missing){JSONObject current=s.require(profile,job);if(current.getString("status").equals("complete"))s.status(profile,job,"error","Локальная копия повреждена; повторите скачивание");if(!fetchMissing)throw missing;Response r=fetchWithRetry(scope,AudioStore.segmentPath(job,ordinal),AudioStore.CHUNK_LIMIT);putChunk(scope,job,ordinal,r.bytes);s.recount(profile,job,"partial",null);return s.chunk(profile,job,ordinal);}
    }
    JSONObject url(String scope,String job,int ordinal) throws Exception {JSONObject row=get(scope,job);if(row==null)throw new IOException("Аудиокнига не добавлена");boolean offline;try{chunk(scope,job,ordinal,false);offline=true;}catch(IOException e){offline=false;}return new JSONObject().put("url","https://appassets.androidplatform.net/local-audio/"+AudioStore.checksum(scope)+"/"+AudioStore.id(job)+"/"+ordinal+"/"+row.getString("manifestSha256")+".wav").put("offline",offline);}
    private synchronized void putChunk(String scope,String job,int ordinal,byte[] bytes) throws Exception {AudioStore s=store(scope);String profile=profile(scope);File target=s.chunkFile(profile,job,ordinal);long previous=target.exists()?target.length():0;if(accountedBytes-previous+bytes.length+1024*1024>AudioStore.QUOTA)throw new IOException("Хранилище аудио заполнено (8 ГБ)");s.putChunk(profile,job,ordinal,bytes);accountedBytes=accountedBytes-previous+bytes.length;}
    void cancelIO(Thread thread){fetcher.cancel(thread);if(thread!=null)thread.interrupt();}
    void close(){cancelled=true;fetcher.cancel(downloadThread);downloads.shutdownNow();}
}
