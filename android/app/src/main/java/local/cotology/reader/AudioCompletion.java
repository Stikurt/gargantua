package local.cotology.reader;

import org.json.*;
import java.io.IOException;

/** Called only after MediaPlayer's actual completion event, using the verified manifest. */
final class AudioCompletion {
    static JSONObject position(JSONObject row,int ordinal,double rate,long updatedAt) throws Exception {
        String job=AudioStore.id(row.getString("jobId")),hash=AudioStore.checksum(row.getString("manifestSha256"));
        JSONObject manifest=row.getJSONObject("manifest");JSONArray segments=manifest.getJSONArray("segments");
        if(!job.equals(manifest.getString("jobId"))||ordinal<0||ordinal>=segments.length()||!Double.isFinite(rate)||rate<0.5||rate>2||updatedAt<0||updatedAt>9007199254740991L)throw new IOException("Неверное завершение аудиофрагмента");
        double duration=AudioStore.number(segments.getJSONObject(ordinal),"durationSeconds");
        if(duration<0.1||duration>180)throw new IOException("Неверная длительность аудиофрагмента");
        boolean completed=ordinal==segments.length()-1;
        // MediaPlayer's millisecond counter may be below this PCM frame endpoint.
        // Completion is authoritative; never turn it back into approximate playback progress.
        return new JSONObject().put("jobId",job).put("manifestSha256",hash).put("ordinal",completed?ordinal:ordinal+1).put("seconds",completed?duration:0).put("rate",rate).put("updatedAt",updatedAt).put("completed",completed);
    }
}
