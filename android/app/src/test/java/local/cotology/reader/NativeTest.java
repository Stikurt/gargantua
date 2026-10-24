package local.cotology.reader;
import org.junit.*;
import org.junit.rules.TemporaryFolder;
import org.json.*;
import java.io.File;
import static org.junit.Assert.*;
public class NativeTest {
    @Rule public TemporaryFolder temporary=new TemporaryFolder();
    @Test public void onlyTailnetHttps(){
        assertEquals("https://my-pc.tail123.ts.net",ServerAddress.validate("https://my-pc.tail123.ts.net/"));
        for(String bad:new String[]{"http://my-pc.tail123.ts.net","https://example.com","https://my-pc.tail123.ts.net.evil.org","https://my-pc.tail123.ts.net@evil.org","https://my-pc.tail123.ts.net:443","https://my-pc.tail123.ts.net/api","https://my-pc.tail123.ts.net?x=y"})assertThrows(IllegalArgumentException.class,()->ServerAddress.validate(bad));
    }
    @Test public void apiCannotEscape(){
        assertEquals("/api/books?page=1",ServerAddress.apiPath("/api/books?page=1"));
        for(String bad:new String[]{"https://evil.org/api/books","//evil.org/api/books","/api/../other","/api/%2e%2e/other","/api/books#x","/api/\\evil"})assertThrows(IllegalArgumentException.class,()->ServerAddress.apiPath(bad));
    }
    @Test public void filesSurviveReopenAndStayWithinStore() throws Exception {
        File root=temporary.newFolder();String key="11111111-1111-1111-1111-111111111111:book:22222222-2222-2222-2222-222222222222";
        new LocalStore(root).put(key,new JSONObject().put("title","Проверка").put("chapters",new JSONArray().put("Текст без сети")));
        LocalStore reopened=new LocalStore(root);assertEquals("Проверка",((JSONObject)reopened.get(key)).getString("title"));assertEquals(1,reopened.keys("111").length());assertEquals(1,reopened.entries("111").length());
        assertThrows(java.io.IOException.class,()->reopened.put("../../outside","x"));
        reopened.remove(key);assertEquals(0,new LocalStore(root).keys("").length());assertEquals(JSONObject.NULL,reopened.get(key));
    }
}
