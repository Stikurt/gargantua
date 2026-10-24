package local.cotology.reader;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.Bundle;
import android.security.keystore.*;
import android.util.Base64;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import androidx.webkit.*;
import org.json.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private static final String HOST="appassets.androidplatform.net",ORIGIN="https://"+HOST;
    private final ExecutorService tasks=Executors.newSingleThreadExecutor();
    private WebView web;
    private volatile String server="",cookie="";
    private LocalStore store,deviceStore;
    private AudioLibrary audioLibrary;
    private ValueCallback<Uri[]> fileCallback;
    private final String csp="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);
        try{server=getPreferences(0).getString("server","");if(!server.isEmpty())server=ServerAddress.validate(server);openStore();loadCookie();audioLibrary=AudioRuntime.library(this);AudioSession.server(this,server);}catch(Exception e){showFailure("Не удалось открыть локальную библиотеку. Данные не удалены.");return;}
        web=new WebView(this);
        FrameLayout root=new FrameLayout(this);root.setBackgroundColor(android.graphics.Color.rgb(245,243,237));
        root.addView(web,new FrameLayout.LayoutParams(-1,-1));setContentView(root);
        if(android.os.Build.VERSION.SDK_INT>=30){
            root.setOnApplyWindowInsetsListener((view,insets)->{
                android.graphics.Insets bars=insets.getInsets(android.view.WindowInsets.Type.systemBars()|android.view.WindowInsets.Type.ime()|android.view.WindowInsets.Type.displayCutout());
                FrameLayout.LayoutParams layout=(FrameLayout.LayoutParams)web.getLayoutParams();
                if(layout.leftMargin!=bars.left||layout.topMargin!=bars.top||layout.rightMargin!=bars.right||layout.bottomMargin!=bars.bottom){layout.setMargins(bars.left,bars.top,bars.right,bars.bottom);web.setLayoutParams(layout);}
                return android.view.WindowInsets.CONSUMED;
            });
            android.view.WindowInsetsController controller=getWindow().getInsetsController();
            if(controller!=null)controller.setSystemBarsAppearance(android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS|android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS|android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
            root.requestApplyInsets();
        }
        WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setSupportMultipleWindows(false);settings.setMediaPlaybackRequiresUserGesture(true);
        WebView.setWebContentsDebuggingEnabled(false);
        android.webkit.CookieManager.getInstance().setAcceptCookie(false);
        if(!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)){showFailure("Для работы Cotology обновите Android System WebView через магазин приложений.");return;}
        WebViewCompat.addWebMessageListener(web,"CotologyAndroid",Collections.singleton(ORIGIN),(view,message,source,isMainFrame,reply)->{
            if(!isMainFrame||!ORIGIN.equals(source.toString()))return;
            String raw=message.getData();if(raw==null||raw.length()>46*1024*1024)return;
            tasks.execute(()->{JSONObject response=new JSONObject();try{
                JSONObject request=new JSONObject(raw);response.put("id",request.getLong("id"));JSONArray args=request.getJSONArray("args");Object value;
                switch(request.getString("method")){
                    case "get":value=storeFor(args.getString(0)).get(args.getString(0));break;
                    case "put":value=storeFor(args.getString(0)).put(args.getString(0),args.get(1));break;
                    case "remove":value=storeFor(args.getString(0)).remove(args.getString(0));break;
                    case "keys":value=storeFor(args.getString(0)).keys(args.getString(0));break;
                    case "entries":value=storeFor(args.getString(0)).entries(args.getString(0));break;
                    case "request":value=request(args.getJSONObject(0));break;
                    case "audioRegister":value=audioLibrary.register(args.getJSONObject(0));break;
                    case "audioList":value=audioLibrary.list();break;
                    case "audioPlaybackStatus":value=AudioPlaybackService.status();break;
                    case "audioPlayback":value=AudioPlaybackService.command(this,args.getJSONObject(0));break;
                    case "audioGet":case "audioDownload":case "audioCancel":case "audioRemove":case "audioPositionGet":case "audioPositionPut":case "audioUrl":{
                        JSONObject spec=args.getJSONObject(0);String scope=spec.getString("scopeId"),job=spec.getString("jobId");
                        switch(request.getString("method")){
                            case "audioGet":value=audioLibrary.get(scope,job);break;
                            case "audioDownload":value=audioLibrary.download(scope,job);break;
                            case "audioCancel":value=audioLibrary.cancel(scope,job);break;
                            case "audioRemove":AudioPlaybackService.stopIfPlaying(this,scope,job);value=audioLibrary.remove(scope,job);break;
                            case "audioPositionGet":value=audioLibrary.positionGet(scope,job);break;
                            case "audioPositionPut":value=audioLibrary.positionPut(scope,job,spec.getJSONObject("position"));break;
                            default:value=audioLibrary.url(scope,job,spec.getInt("ordinal"));
                        }break;
                    }
                    case "configure":runOnUiThread(this::configure);value=true;break;
                    default:throw new IOException("Неизвестная операция");
                }
                response.put("value",value);
            }catch(Exception e){try{response.put("error",e instanceof IllegalArgumentException?e.getMessage():"Операция не выполнена. Проверьте подключение и свободное место.");}catch(Exception ignored){}}
                runOnUiThread(()->reply.postMessage(response.toString()));
            });
        });
        WebViewAssetLoader loader=new WebViewAssetLoader.Builder().addPathHandler("/",new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){return true;}
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest req){
                Uri uri=req.getUrl();if(!"https".equals(uri.getScheme())||!HOST.equals(uri.getHost()))return blocked();
                try{
                    if(uri.getPath().startsWith("/local-audio/"))return localAudio(req);
                    if(uri.getPath().startsWith("/api/")){
                        if(!req.getMethod().equals("GET"))return blocked();
                        JSONObject r=request(new JSONObject().put("url",uri.getEncodedPath()+(uri.getEncodedQuery()==null?"":"?"+uri.getEncodedQuery())).put("method","GET"));
                        byte[] bytes=Base64.decode(r.getString("data"),Base64.NO_WRAP);
                        return new WebResourceResponse(r.getString("type").split(";")[0],"UTF-8",r.getInt("status"),"API",headers("Cache-Control","no-store","X-Content-Type-Options","nosniff"),new ByteArrayInputStream(bytes));
                    }
                    WebResourceResponse asset=loader.shouldInterceptRequest(uri.getPath().equals("/")?Uri.parse(ORIGIN+"/index.html"):uri);
                    if(asset!=null)asset.setResponseHeaders(headers("Content-Security-Policy",csp,"X-Content-Type-Options","nosniff"));return asset==null?blocked():asset;
                }catch(Exception e){return blocked();}
            }
            @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,android.net.http.SslError error){handler.cancel();}
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onJsPrompt(WebView view,String url,String message,String defaultValue,JsPromptResult result){
                if(!url.startsWith(ORIGIN+"/")){result.cancel();return true;}
                EditText input=new EditText(MainActivity.this);input.setText(defaultValue);new AlertDialog.Builder(MainActivity.this).setTitle(message).setView(input).setPositiveButton("Сохранить",(d,w)->result.confirm(input.getText().toString())).setNegativeButton("Отмена",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show();return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request){request.deny();}
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){
                if(fileCallback!=null)fileCallback.onReceiveValue(null);fileCallback=callback;
                Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                try{startActivityForResult(intent,40);}catch(Exception e){fileCallback.onReceiveValue(null);fileCallback=null;}return true;
            }
        });
        web.loadUrl(ORIGIN+"/");
    }
    private void showFailure(String text){TextView view=new TextView(this);view.setPadding(32,64,32,32);view.setText(text);setContentView(view);}
    private static Map<String,String> headers(String... values){Map<String,String> result=new HashMap<>();for(int i=0;i<values.length;i+=2)result.put(values[i],values[i+1]);return result;}
    private WebResourceResponse blocked(){return new WebResourceResponse("text/plain","UTF-8",403,"Blocked",headers("Cache-Control","no-store"),new ByteArrayInputStream(new byte[0]));}
    private File cookieFile(){return new File(getFilesDir(),"session.enc");}
    private SecretKey sessionKey() throws Exception {
        KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);
        if(keys.containsAlias("cotology-session"))return (SecretKey)keys.getKey("cotology-session",null);
        KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder("cotology-session",KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());return generator.generateKey();
    }
    private synchronized void saveCookie() throws Exception {
        if(cookie.isEmpty()){Files.deleteIfExists(cookieFile().toPath());return;}
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,sessionKey());
        JSONObject envelope=new JSONObject().put("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)).put("data",Base64.encodeToString(cipher.doFinal(cookie.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP));
        File temp=new File(getFilesDir(),"session.tmp");Files.write(temp.toPath(),envelope.toString().getBytes(StandardCharsets.UTF_8));Files.move(temp.toPath(),cookieFile().toPath(),java.nio.file.StandardCopyOption.REPLACE_EXISTING,java.nio.file.StandardCopyOption.ATOMIC_MOVE);
    }
    private void loadCookie(){try{
        JSONObject envelope=new JSONObject(new String(Files.readAllBytes(cookieFile().toPath()),StandardCharsets.UTF_8));Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,sessionKey(),new GCMParameterSpec(128,Base64.decode(envelope.getString("iv"),Base64.NO_WRAP)));cookie=new String(cipher.doFinal(Base64.decode(envelope.getString("data"),Base64.NO_WRAP)),StandardCharsets.UTF_8);
    }catch(Exception e){cookie="";}}
    private LocalStore storeFor(String key){return key.startsWith("00000000-0000-4000-8000-000000000001:")?deviceStore:store;}
    private void openStore() throws Exception {if(deviceStore==null)deviceStore=new LocalStore(new File(getFilesDir(),"device-library"));store=new LocalStore(new File(getFilesDir(),"library/"+LocalStore.hash(server)));}
    private void configure(){
        EditText input=new EditText(this);input.setSingleLine(true);input.setText(server);input.setHint("https://имя-пк.имя-сети.ts.net");input.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_URI);
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("Домашний сервер").setMessage("Включите Tailscale. Вставьте HTTPS-адрес ПК из команды tailscale serve status. Книги разных серверов хранятся отдельно.").setView(input).setNegativeButton("Отмена",null).setPositiveButton("Сохранить",null).create();
        dialog.setOnShowListener(d->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
            final String next;try{next=ServerAddress.validate(input.getText().toString());}catch(Exception e){input.setError("Нужен HTTPS-адрес ПК в Tailscale, без пути");return;}
            tasks.execute(()->{try{synchronized(this){if(!server.equals(next)){cookie="";saveCookie();server=next;getPreferences(0).edit().putString("server",server).commit();AudioSession.server(this,server);openStore();}}runOnUiThread(()->{dialog.dismiss();web.reload();});}catch(Exception e){runOnUiThread(()->input.setError("Не удалось сохранить настройки"));}});
        }));dialog.show();
    }
    private synchronized JSONObject request(JSONObject spec) throws Exception {
        String path=ServerAddress.apiPath(spec.getString("url")),method=spec.optString("method","GET");
        if(!Arrays.asList("GET","POST","PUT","DELETE").contains(method))throw new IllegalArgumentException("Недопустимый метод");
        if(server.isEmpty())return offline();
        HttpURLConnection connection=null;
        try{
            connection=(HttpURLConnection)new URL(server+path).openConnection();connection.setRequestMethod(method);connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(15000);connection.setReadTimeout(90000);connection.setRequestProperty("X-Cotology","1");connection.setRequestProperty("Origin","http://localhost:3080");if(!cookie.isEmpty())connection.setRequestProperty("Cookie",cookie);
            JSONObject headers=spec.optJSONObject("headers");if(headers!=null)for(String key:Arrays.asList("Content-Type","X-CSRF-Token"))if(headers.has(key))connection.setRequestProperty(key,headers.getString(key));
            byte[] body=null;
            if(spec.has("file")){
                JSONObject file=spec.getJSONObject("file");String name=file.getString("name");if(!name.matches("[^\\r\\n\"/\\\\]{1,200}\\.(?i:epub|fb2|txt)"))throw new IOException("Недопустимое имя файла");
                byte[] bytes=Base64.decode(file.getString("data"),Base64.NO_WRAP);if(bytes.length>20*1024*1024)throw new IOException("Файл больше 20 МБ");
                String boundary="cotology-"+UUID.randomUUID();ByteArrayOutputStream out=new ByteArrayOutputStream();out.write(("--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\""+name+"\"\r\nContent-Type: application/octet-stream\r\n\r\n").getBytes(StandardCharsets.UTF_8));out.write(bytes);out.write(("\r\n--"+boundary+"--\r\n").getBytes(StandardCharsets.UTF_8));body=out.toByteArray();connection.setRequestProperty("Content-Type","multipart/form-data; boundary="+boundary);
            }else if(spec.has("body"))body=spec.getString("body").getBytes(StandardCharsets.UTF_8);
            if(body!=null){if(method.equals("GET")||body.length>21*1024*1024)throw new IOException("Недопустимый запрос");connection.setDoOutput(true);connection.setFixedLengthStreamingMode(body.length);try(OutputStream out=connection.getOutputStream()){out.write(body);}}
            int status=connection.getResponseCode();if(status>=300&&status<400)throw new IOException("Перенаправление запрещено");
            List<String> cookies=new ArrayList<>();for(Map.Entry<String,List<String>> field:connection.getHeaderFields().entrySet())if(field.getKey()!=null&&field.getKey().equalsIgnoreCase("Set-Cookie"))cookies.addAll(field.getValue());
            for(String value:cookies)if(value.startsWith("cotology=")){cookie=value.split(";",2)[0];if(cookie.equals("cotology="))cookie="";saveCookie();}
            InputStream stream=status>=400?connection.getErrorStream():connection.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream();
            if(stream!=null)try(InputStream in=stream){byte[] buffer=new byte[16384];int count;while((count=in.read(buffer))!=-1){if(out.size()+count>32*1024*1024)throw new IOException("Ответ слишком большой");out.write(buffer,0,count);}}
            return new JSONObject().put("status",status).put("type",Objects.toString(connection.getContentType(),"application/json")).put("data",Base64.encodeToString(out.toByteArray(),Base64.NO_WRAP)).put("offline",false);
        }catch(IOException e){return offline();}finally{if(connection!=null)connection.disconnect();}
    }
    private JSONObject offline() throws JSONException {return new JSONObject().put("status",503).put("type","application/json").put("data",Base64.encodeToString("{}".getBytes(StandardCharsets.UTF_8),Base64.NO_WRAP)).put("offline",true);}
    private WebResourceResponse localAudio(WebResourceRequest req) throws Exception {
        Uri uri=req.getUrl();String[] parts=uri.getPath().split("/");if(!req.getMethod().equals("GET")||uri.getQuery()!=null||parts.length!=6||!parts[4].matches("0|[1-9][0-9]{0,4}")||!parts[5].matches("[a-f0-9]{64}\\.wav"))return blocked();
        String scope=AudioStore.checksum(parts[2]),job=AudioStore.id(parts[3]);int ordinal=Integer.parseInt(parts[4]);JSONObject row=audioLibrary.get(scope,job);if(row==null||!parts[5].equals(row.getString("manifestSha256")+".wav"))return blocked();byte[] bytes=audioLibrary.chunk(scope,job,ordinal,true);Map<String,String> response=headers("Cache-Control","no-store","X-Content-Type-Options","nosniff","Content-Security-Policy","default-src 'none'","Accept-Ranges","bytes","Content-Type","audio/wav");
        String range=req.getRequestHeaders().get("Range");int start=0,end=bytes.length-1,status=200;if(range!=null){java.util.regex.Matcher match=java.util.regex.Pattern.compile("bytes=([0-9]{1,10})-([0-9]{0,10})").matcher(range);if(!match.matches())return new WebResourceResponse("audio/wav",null,416,"Range",headers("Content-Range","bytes */"+bytes.length),new ByteArrayInputStream(new byte[0]));long a=Long.parseLong(match.group(1)),b=match.group(2).isEmpty()?end:Long.parseLong(match.group(2));if(a>=bytes.length||b<a)return new WebResourceResponse("audio/wav",null,416,"Range",headers("Content-Range","bytes */"+bytes.length),new ByteArrayInputStream(new byte[0]));start=(int)a;end=(int)Math.min(b,end);status=206;response.put("Content-Range","bytes "+start+"-"+end+"/"+bytes.length);}response.put("Content-Length",Integer.toString(end-start+1));return new WebResourceResponse("audio/wav",null,status,status==206?"Partial Content":"OK",response,new ByteArrayInputStream(bytes,start,end-start+1));
    }
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==40&&fileCallback!=null){Uri uri=result==RESULT_OK&&data!=null?data.getData():null;fileCallback.onReceiveValue(uri!=null&&"content".equals(uri.getScheme())?new Uri[]{uri}:null);fileCallback=null;}}
    @Override public void onBackPressed(){if(web!=null)web.evaluateJavascript("window.dispatchEvent(new Event('cotology-back',{cancelable:true}))",value->{if("true".equals(value))finish();});else super.onBackPressed();}
    @Override protected void onDestroy(){if(fileCallback!=null)fileCallback.onReceiveValue(null);if(web!=null){web.stopLoading();web.destroy();}tasks.shutdownNow();super.onDestroy();}
}

