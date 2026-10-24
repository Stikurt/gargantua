package local.cotology.reader;

import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/** Only inert JSON in the application's private files; never accepts a path from the page. */
final class LocalStore {
    private final File root;
    private final JSONObject index;
    LocalStore(File root) throws Exception {
        this.root=root;root.mkdirs();
        File file=new File(root,"index.json");
        index=file.exists()?new JSONObject(read(file,4*1024*1024)):new JSONObject();
        Iterator<String> keys=index.keys();while(keys.hasNext()){String key=keys.next();check(key);if(index.getLong(key)<0)throw new IOException("Повреждён индекс");}
    }
    static String hash(String value) throws Exception {
        byte[] digest=MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result=new StringBuilder();for(byte b:digest)result.append(String.format(Locale.ROOT,"%02x",b&255));return result.toString();
    }
    private void check(String key) throws IOException {
        if(key==null||!key.matches("^(lastProfile|[a-f0-9-]{36}:[a-zA-Z0-9:-]{1,180})$"))throw new IOException("Недопустимый ключ библиотеки");
    }
    private File location(String key) throws Exception {
        check(key);String[] parts=key.split(":");
        if(parts.length==3&&parts[1].equals("book")&&parts[2].matches("[a-f0-9-]{36}"))return new File(root,"books/"+parts[0]+"/"+parts[2]+".cotology.json");
        return new File(root,"metadata/"+hash(key)+".json");
    }
    private static String read(File file,int max) throws IOException {
        if(file.length()>max)throw new IOException("Слишком большой локальный файл");
        return new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8);
    }
    private static void atomic(File file,String content) throws IOException {
        file.getParentFile().mkdirs();File temporary=new File(file.getPath()+".tmp");
        try(FileOutputStream out=new FileOutputStream(temporary)){out.write(content.getBytes(StandardCharsets.UTF_8));out.getFD().sync();}
        Files.move(temporary.toPath(),file.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
    }
    synchronized Object get(String key) throws Exception {
        File file=location(key);if(!file.exists())return JSONObject.NULL;
        JSONObject record=new JSONObject(read(file,32*1024*1024));if(!record.getString("key").equals(key))throw new IOException("Повреждён файл книги");return record.get("value");
    }
    synchronized Object put(String key,Object value) throws Exception {
        check(key);String text=new JSONObject().put("key",key).put("value",value).toString();long size=text.getBytes(StandardCharsets.UTF_8).length;
        if(size>32*1024*1024)throw new IOException("Пакет превышает 32 МБ");
        long total=size-index.optLong(key,0);Iterator<String> keys=index.keys();while(keys.hasNext())total+=index.getLong(keys.next());
        if(total>2L*1024*1024*1024||(!index.has(key)&&index.length()>=30000))throw new IOException("Локальное хранилище заполнено (2 ГБ)");
        if(root.getUsableSpace()<size+64L*1024*1024)throw new IOException("Недостаточно свободного места");
        atomic(location(key),text);index.put(key,size);atomic(new File(root,"index.json"),index.toString());return true;
    }
    synchronized Object remove(String key) throws Exception {
        Files.deleteIfExists(location(key).toPath());index.remove(key);atomic(new File(root,"index.json"),index.toString());return true;
    }
    synchronized JSONArray keys(String prefix) throws Exception {
        if(prefix.length()>220)throw new IOException("Неверный фильтр");JSONArray result=new JSONArray();Iterator<String> keys=index.keys();while(keys.hasNext()){String key=keys.next();if(key.startsWith(prefix))result.put(key);}return result;
    }
    synchronized JSONArray entries(String prefix) throws Exception {
        JSONArray keys=keys(prefix),result=new JSONArray();for(int i=0;i<keys.length();i++){String key=keys.getString(i);result.put(new JSONArray().put(key).put(get(key)));}return result;
    }
}
