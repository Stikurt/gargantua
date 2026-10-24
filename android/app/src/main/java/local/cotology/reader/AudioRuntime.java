package local.cotology.reader;
import android.content.Context;
import java.io.File;
final class AudioRuntime {
    private static AudioLibrary library;
    static synchronized AudioLibrary library(Context context) throws Exception {if(library==null)library=new AudioLibrary(new File(context.getFilesDir(),"audio-library"),new AudioSession(context));return library;}
}
