package local.gargantua.mvp;

import java.util.HashMap;
import java.util.Map;

/** Per-source recovery only counts real successful HTTP chapters, never cached text. */
final class DownloadPacing {
    static final long FLOOR_MS = 1000, MAX_MS = 30000, QUIET_MS = 60000;
    static final int RECOVERY_SUCCESSES = 8;
    private static final class Streak {
        final long cooldown;
        long pacing;
        int successes;
        Streak(long cooldown, long pacing) { this.cooldown = cooldown; this.pacing = pacing; }
    }
    private final Map<String, Streak> sources = new HashMap<>();
    static long normalized(long pacing) { return Math.max(FLOOR_MS, Math.min(MAX_MS, pacing)); }
    static long afterRateLimit(long pacing) { return Math.min(MAX_MS, normalized(pacing) * 2); }
    void failed(String source) { sources.remove(source); }
    long completed(String source, long current, long cooldownUntil, long now, boolean realHttp) {
        long pacing = normalized(current);
        if (!realHttp) return pacing;
        Streak state = sources.get(source);
        if (state == null || state.cooldown != cooldownUntil || state.pacing != pacing) {
            state = new Streak(cooldownUntil, pacing); sources.put(source, state);
        }
        long quietUntil = cooldownUntil > Long.MAX_VALUE - QUIET_MS ? Long.MAX_VALUE : Math.max(0, cooldownUntil) + QUIET_MS;
        if (now < quietUntil || pacing == FLOOR_MS) { state.successes = 0; return pacing; }
        if (++state.successes < RECOVERY_SUCCESSES) return pacing;
        state.successes = 0; state.pacing = Math.max(FLOOR_MS, pacing / 2);
        return state.pacing;
    }
}
