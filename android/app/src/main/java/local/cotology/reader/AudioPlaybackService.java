package local.cotology.reader;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.media.*;
import android.media.session.*;
import android.os.*;
import org.json.*;
import java.io.*;
import java.util.concurrent.*;

/** Foreground, app-private PCM player. It never accepts a path, URI, or arbitrary network address. */
public final class AudioPlaybackService extends Service {
    private static final String CHANNEL="gargantua-audio",COMMAND="local.cotology.reader.AUDIO_COMMAND";
    private static volatile String snapshot="{\"playing\":false,\"buffering\":false}";
    private static volatile AudioPlaybackService instance;
    private static final java.util.Map<String,CompletableFuture<JSONObject>> replies=new ConcurrentHashMap<>();
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    private AudioLibrary library;private MediaPlayer player;private MediaSession session;private AudioManager audio;
    private AudioFocusRequest focus;private String scope="",job="",title="Аудиокнига",error=null;private JSONObject row;
    private PowerManager.WakeLock preparationLock;
    private int ordinal=0,generation=0;private double seconds=0,rate=1;private boolean desired=false,prepared=false,buffering=false,completed=false,resumeOnGain=false;private long lastSaved=0;
    private volatile Thread loadingThread;
    static JSONObject status() throws JSONException {AudioPlaybackService active=instance;return new JSONObject(snapshot).put("loaded",active!=null&&active.row!=null);}
    static JSONObject command(Context context,JSONObject spec) throws Exception {
        String action=spec.getString("action");if(!java.util.Arrays.asList("load","play","pause","seek","rate","stop").contains(action))throw new IOException("Неизвестная команда плеера");
        AudioPlaybackService active=instance;
        if(action.equals("play")&&(active==null||active.row==null)&&spec.has("scopeId")&&spec.has("jobId")){spec=new JSONObject(spec.toString()).put("action","load").put("autoplay",true);action="load";}
        if(!action.equals("load")&&active!=null&&active.row!=null&&spec.has("scopeId")&&(!spec.getString("scopeId").equals(active.scope)||!spec.getString("jobId").equals(active.job)))throw new IOException("Плеер уже открыл другую аудиокнигу");
        if(action.equals("load")){AudioStore.checksum(spec.getString("scopeId"));AudioStore.id(spec.getString("jobId"));}
        if(instance==null&&!action.equals("load")&&!action.equals("play"))return status();
        String token=java.util.UUID.randomUUID().toString();CompletableFuture<JSONObject> response=new CompletableFuture<>();replies.put(token,response);
        try{Intent intent=new Intent(context,AudioPlaybackService.class).setAction(COMMAND).putExtra("command",spec.toString()).putExtra("reply",token);context.startForegroundService(intent);return response.get(15,TimeUnit.SECONDS);}finally{replies.remove(token);}
    }
    private final BroadcastReceiver noisy=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){pause();}};
    @Override public void onCreate(){super.onCreate();instance=this;try{library=AudioRuntime.library(this);}catch(Exception e){stopSelf();return;}
        audio=(AudioManager)getSystemService(AUDIO_SERVICE);preparationLock=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"Cotology:audio-prepare");preparationLock.setReferenceCounted(false);AudioAttributes attributes=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
        focus=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attributes).setOnAudioFocusChangeListener(change->{if(change==AudioManager.AUDIOFOCUS_GAIN){if(resumeOnGain){resumeOnGain=false;play();}}else{boolean resume=(change==AudioManager.AUDIOFOCUS_LOSS_TRANSIENT||change==AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)&&desired;pause(change==AudioManager.AUDIOFOCUS_LOSS);resumeOnGain=resume;}}).setWillPauseWhenDucked(true).build();
        session=new MediaSession(this,"GargantuaAudiobook");session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS|MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);session.setCallback(new MediaSession.Callback(){@Override public void onPlay(){play();}@Override public void onPause(){pause();}@Override public void onStop(){finish();}@Override public void onSeekTo(long value){seek(ordinal,Math.max(0,value)/1000.0);}@Override public void onSkipToNext(){seek(ordinal+1,0);}@Override public void onSkipToPrevious(){seek(Math.max(0,ordinal-1),0);}@Override public void onFastForward(){relative(15);}@Override public void onRewind(){relative(-15);}});session.setActive(true);
        ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(new NotificationChannel(CHANNEL,"Аудиокниги",NotificationManager.IMPORTANCE_LOW));
        if(Build.VERSION.SDK_INT>=33)registerReceiver(noisy,new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),Context.RECEIVER_NOT_EXPORTED);else registerReceiver(noisy,new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
        startForeground(71,notification(),ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);handler.post(tick);
    }
    @Override public int onStartCommand(Intent intent,int flags,int id){if(intent==null){finish();return START_NOT_STICKY;}try{
        if(COMMAND.equals(intent.getAction())){JSONObject spec=new JSONObject(intent.getStringExtra("command"));String action=spec.getString("action");
            if(action.equals("load"))load(spec);else if(action.equals("play"))play();else if(action.equals("pause"))pause();else if(action.equals("stop"))finish();else if(action.equals("seek"))seek(spec.optInt("ordinal",ordinal),spec.optDouble("seconds",seconds));else if(action.equals("rate")){double next=spec.getDouble("rate");if(!Double.isFinite(next)||next<0.5||next>2)throw new IOException("Неверная скорость");rate=next;if(prepared&&player!=null){player.setPlaybackParams(player.getPlaybackParams().setSpeed((float)rate));if(!desired)player.pause();}save(true);update();}}
        else if("play".equals(intent.getAction()))play();else if("pause".equals(intent.getAction()))pause();else if("next".equals(intent.getAction()))relative(15);else if("previous".equals(intent.getAction()))relative(-15);else if("stop".equals(intent.getAction()))finish();
    }catch(Exception e){failure(e);}finally{String token=intent.getStringExtra("reply");CompletableFuture<JSONObject> future=token==null?null:replies.get(token);if(future!=null)try{future.complete(status());}catch(Exception e){future.completeExceptionally(e);}}return START_NOT_STICKY;}
    private void load(JSONObject spec) throws Exception {
        String nextScope=AudioStore.checksum(spec.getString("scopeId")),nextJob=AudioStore.id(spec.getString("jobId"));if(scope.equals(nextScope)&&job.equals(nextJob)){update();return;}
        JSONObject nextRow=library.get(nextScope,nextJob);if(nextRow==null)throw new IOException("Аудиокнига не добавлена");Object p=library.positionGet(nextScope,nextJob);
        save(true);releasePlayer();scope=nextScope;job=nextJob;row=nextRow;title=row.optString("title","Аудиокнига");ordinal=0;seconds=0;rate=1;completed=false;error=null;if(p instanceof JSONObject){JSONObject position=(JSONObject)p;ordinal=position.getInt("ordinal");seconds=position.getDouble("seconds");rate=position.getDouble("rate");completed=position.optBoolean("completed");}
        boolean explicitPosition=spec.has("ordinal")||spec.has("seconds");
        if(spec.has("ordinal"))ordinal=spec.getInt("ordinal");if(spec.has("seconds"))seconds=spec.getDouble("seconds");if(spec.has("rate"))rate=spec.getDouble("rate");desired=spec.optBoolean("autoplay",false);
        if(!Double.isFinite(rate)||rate<0.5||rate>2)throw new IOException("Неверная скорость");
        if(completed&&!explicitPosition){
            // A paused restore needs no decoder at the end of the last track.
            // Seeking a prepared player to its end can itself deliver completion
            // and race the first Play after a cold start.
            if(desired){ordinal=0;seconds=0;completed=false;}
            else{library.cancelIO(loadingThread);generation++;buffering=false;update();return;}
        }
        prepare(ordinal,seconds);
    }
    private void prepare(int nextOrdinal,double nextSeconds){
        try{JSONArray segments=row.getJSONObject("manifest").getJSONArray("segments");if(nextOrdinal<0||nextOrdinal>=segments.length()||!Double.isFinite(nextSeconds)||nextSeconds<0||!Double.isFinite(rate)||rate<0.5||rate>2)throw new IOException("Неверная позиция");seconds=Math.min(nextSeconds,segments.getJSONObject(nextOrdinal).getDouble("durationSeconds"));ordinal=nextOrdinal;completed=ordinal==segments.length()-1&&seconds>=segments.getJSONObject(ordinal).getDouble("durationSeconds");library.cancelIO(loadingThread);releasePlayer();int token=++generation;preparationLock.acquire(120000);buffering=true;error=null;update();String loadingScope=scope,loadingJob=job;io.execute(()->{if(token!=generation)return;loadingThread=Thread.currentThread();try{
            library.chunk(loadingScope,loadingJob,nextOrdinal,true);JSONObject info=library.scopeInfo(loadingScope);File file=library.store(loadingScope).chunkFile(info.getString("profileId"),loadingJob,nextOrdinal);
            handler.post(()->{if(token!=generation)return;try{MediaPlayer mp=new MediaPlayer();player=mp;mp.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());mp.setWakeMode(getApplicationContext(),PowerManager.PARTIAL_WAKE_LOCK);try(FileInputStream in=new FileInputStream(file)){mp.setDataSource(in.getFD());}mp.setOnPreparedListener(value->{if(token!=generation)return;buffering=false;prepared=true;if(preparationLock.isHeld())preparationLock.release();value.setOnSeekCompleteListener(v->{v.setOnSeekCompleteListener(null);if(desired)play();else update();});value.seekTo(Math.round(seconds*1000),MediaPlayer.SEEK_CLOSEST);if(seconds==0){value.setOnSeekCompleteListener(null);if(desired)play();else update();}});mp.setOnCompletionListener(value->advance());mp.setOnErrorListener((value,what,extra)->{failure(new IOException("Не удалось воспроизвести PCM"));return true;});mp.prepareAsync();}catch(Exception e){failure(e);}});
        }catch(Exception e){handler.post(()->{if(token==generation)failure(e);});}finally{loadingThread=null;}});
        }catch(Exception e){failure(e);}
    }
    private void advance(){try{
        JSONObject endpoint=AudioCompletion.position(row,ordinal,rate,System.currentTimeMillis());
        // Release before save: currentSeconds() must not replace the exact PCM
        // endpoint with MediaPlayer's rounded or stale millisecond counter.
        releasePlayer();ordinal=endpoint.getInt("ordinal");seconds=endpoint.getDouble("seconds");completed=endpoint.getBoolean("completed");
        save(true);
        if(!completed)prepare(ordinal,seconds);else{desired=false;audio.abandonAudioFocusRequest(focus);update();}
    }catch(Exception e){failure(e);}}
    private void play(){if(row==null){finish();return;}desired=true;resumeOnGain=false;if(completed){prepare(0,0);return;}if(buffering){update();return;}if(!prepared){prepare(ordinal,seconds);return;}if(audio.requestAudioFocus(focus)!=AudioManager.AUDIOFOCUS_REQUEST_GRANTED){desired=false;update();return;}try{player.setPlaybackParams(player.getPlaybackParams().setSpeed((float)rate));player.start();error=null;update();}catch(Exception e){failure(e);}}
    private void pause(){pause(true);}
    private void pause(boolean abandon){resumeOnGain=false;desired=false;try{if(player!=null&&prepared&&player.isPlaying())player.pause();}catch(Exception ignored){}save(true);if(abandon&&audio!=null&&focus!=null)audio.abandonAudioFocusRequest(focus);update();}
    private void seek(int next,double value){save(true);prepare(next,value);}
    private void relative(double difference){try{double value=currentSeconds()+difference;JSONArray parts=row.getJSONObject("manifest").getJSONArray("segments");int next=ordinal;while(value<0&&next>0){next--;value+=parts.getJSONObject(next).getDouble("durationSeconds");}while(next+1<parts.length()&&value>=parts.getJSONObject(next).getDouble("durationSeconds")){value-=parts.getJSONObject(next).getDouble("durationSeconds");next++;}seek(next,Math.max(0,value));}catch(Exception e){failure(e);}}
    private double currentSeconds(){double result=seconds;try{if(prepared&&player!=null)result=Math.max(0,player.getCurrentPosition()/1000.0);if(row!=null)result=Math.min(result,row.getJSONObject("manifest").getJSONArray("segments").getJSONObject(ordinal).getDouble("durationSeconds"));}catch(Exception ignored){}return result;}
    private void save(boolean force){if(row==null||scope.isEmpty()||job.isEmpty())return;long now=System.currentTimeMillis();if(!force&&now-lastSaved<5000)return;try{seconds=currentSeconds();JSONObject p=new JSONObject().put("jobId",job).put("manifestSha256",row.getString("manifestSha256")).put("ordinal",ordinal).put("seconds",seconds).put("rate",rate).put("updatedAt",now).put("completed",completed);library.positionPut(scope,job,p);lastSaved=now;}catch(Exception e){error="Не удалось сохранить позицию";}}
    private void update(){try{boolean playing=prepared&&player!=null&&player.isPlaying();snapshot=new JSONObject().put("scopeId",scope).put("jobId",job).put("ordinal",ordinal).put("seconds",currentSeconds()).put("rate",rate).put("playing",playing).put("buffering",buffering).put("completed",completed).put("position",row==null?JSONObject.NULL:new JSONObject().put("jobId",job).put("manifestSha256",row.getString("manifestSha256")).put("ordinal",ordinal).put("seconds",currentSeconds()).put("rate",rate).put("updatedAt",System.currentTimeMillis()).put("completed",completed)).put("error",error==null?JSONObject.NULL:error).toString();long actions=PlaybackState.ACTION_PLAY|PlaybackState.ACTION_PAUSE|PlaybackState.ACTION_PLAY_PAUSE|PlaybackState.ACTION_STOP|PlaybackState.ACTION_SEEK_TO|PlaybackState.ACTION_SKIP_TO_NEXT|PlaybackState.ACTION_SKIP_TO_PREVIOUS|PlaybackState.ACTION_FAST_FORWARD|PlaybackState.ACTION_REWIND;session.setPlaybackState(new PlaybackState.Builder().setActions(actions).setState(buffering?PlaybackState.STATE_BUFFERING:playing?PlaybackState.STATE_PLAYING:PlaybackState.STATE_PAUSED,Math.round(currentSeconds()*1000),(float)rate).build());long duration=row==null?0:Math.round(row.getJSONObject("manifest").getJSONArray("segments").getJSONObject(ordinal).getDouble("durationSeconds")*1000);session.setMetadata(new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE,title).putString(MediaMetadata.METADATA_KEY_ARTIST,"Фрагмент "+(ordinal+1)+(row==null?"":" из "+row.getInt("totalSegments"))).putLong(MediaMetadata.METADATA_KEY_DURATION,duration).build());startForeground(71,notification(),ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);}catch(Exception ignored){}}
    private PendingIntent action(String action,int id){return PendingIntent.getForegroundService(this,id,new Intent(this,AudioPlaybackService.class).setAction(action),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
    private Notification notification(){boolean playing=desired;PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);Notification.Builder n=new Notification.Builder(this,CHANNEL).setSmallIcon(local.cotology.reader.R.drawable.app_icon).setContentTitle(title).setContentText(buffering?"Подготовка фрагмента…":playing?"Аудиокнига · воспроизведение":"Аудиокнига · пауза").setContentIntent(open).setOnlyAlertOnce(true).setOngoing(playing).setVisibility(Notification.VISIBILITY_PUBLIC).addAction(new Notification.Action.Builder(android.R.drawable.ic_media_rew,"−15 с",action("previous",1)).build()).addAction(new Notification.Action.Builder(playing?android.R.drawable.ic_media_pause:android.R.drawable.ic_media_play,playing?"Пауза":"Продолжить",action(playing?"pause":"play",2)).build()).addAction(new Notification.Action.Builder(android.R.drawable.ic_media_ff,"+15 с",action("next",3)).build()).addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel,"Закрыть",action("stop",4)).build());if(session!=null)n.setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0,1,2));return n.build();}
    private final Runnable tick=new Runnable(){public void run(){if(instance!=AudioPlaybackService.this)return;save(false);update();handler.postDelayed(this,1000);}};
    private void releasePlayer(){prepared=false;if(player!=null){try{player.release();}catch(Exception ignored){}player=null;}}
    private void failure(Exception e){if(preparationLock!=null&&preparationLock.isHeld())preparationLock.release();desired=false;buffering=false;error=e.getMessage()==null?"Ошибка воспроизведения":e.getMessage();save(true);releasePlayer();update();}
    private void finish(){pause();generation++;stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();}
    static void stopIfPlaying(Context context,String scope,String job){AudioPlaybackService s=instance;if(s!=null&&s.scope.equals(scope)&&s.job.equals(job))context.stopService(new Intent(context,AudioPlaybackService.class));}
    @Override public android.os.IBinder onBind(Intent intent){return null;}
    @Override public void onTaskRemoved(Intent rootIntent){save(true);super.onTaskRemoved(rootIntent);}
    @Override public void onDestroy(){if(preparationLock!=null&&preparationLock.isHeld())preparationLock.release();save(true);generation++;handler.removeCallbacksAndMessages(null);if(library!=null)library.cancelIO(loadingThread);io.shutdownNow();releasePlayer();if(audio!=null&&focus!=null)audio.abandonAudioFocusRequest(focus);try{unregisterReceiver(noisy);}catch(Exception ignored){}if(session!=null)session.release();instance=null;try{snapshot=new JSONObject(snapshot).put("playing",false).put("buffering",false).toString();}catch(Exception ignored){}super.onDestroy();}
}
