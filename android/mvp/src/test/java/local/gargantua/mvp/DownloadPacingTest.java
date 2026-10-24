package local.gargantua.mvp;

import org.junit.Test;
import static org.junit.Assert.*;

public class DownloadPacingTest {
    private final long cooldown = 100000, quiet = cooldown + DownloadPacing.QUIET_MS;
    @Test public void aNewRateLimitDoublesCurrentPacingInsteadOfLifetimePenalty() {
        assertEquals(2000, DownloadPacing.afterRateLimit(1000));
        assertEquals(8000, DownloadPacing.afterRateLimit(4000));
        assertEquals(30000, DownloadPacing.afterRateLimit(16000));
        assertEquals(30000, DownloadPacing.afterRateLimit(30000));
        // A recovered source starts from its current value even after any old429s.
        assertEquals(2000, DownloadPacing.afterRateLimit(1000));
    }
    @Test public void noRecoveryCanShortenRetryAfterOrItsQuietWindow() {
        DownloadPacing policy = new DownloadPacing();
        for (int i = 0; i < 30; i++) assertEquals(16000, policy.completed("litlife", 16000, cooldown, quiet - 1, true));
        for (int i = 0; i < 7; i++) assertEquals(16000, policy.completed("litlife", 16000, cooldown, quiet + i, true));
        assertEquals(8000, policy.completed("litlife", 16000, cooldown, quiet + 7, true));
    }
    @Test public void sustainedRealHttpSuccessGraduallyHalvesThePenaltyToTheFloor() {
        DownloadPacing policy = new DownloadPacing(); long pacing = 16000;
        for (long expected : new long[]{8000, 4000, 2000, 1000, 1000}) {
            for (int i = 0; i < DownloadPacing.RECOVERY_SUCCESSES; i++) pacing = policy.completed("litlife", pacing, cooldown, quiet + 1, true);
            assertEquals(expected, pacing);
        }
    }
    @Test public void cachedChaptersNeverCountTowardHttpRecovery() {
        DownloadPacing policy = new DownloadPacing();
        for (int i = 0; i < 5000; i++) assertEquals(16000, policy.completed("litlife", 16000, cooldown, quiet, false));
        for (int i = 0; i < 7; i++) assertEquals(16000, policy.completed("litlife", 16000, cooldown, quiet, true));
        assertEquals(8000, policy.completed("litlife", 16000, cooldown, quiet, true));
    }
    @Test public void everyFailureBreaksTheSustainedSuccessStreak() {
        DownloadPacing policy = new DownloadPacing();
        for (int i = 0; i < 7; i++) policy.completed("litlife", 16000, cooldown, quiet, true);
        policy.failed("litlife");
        assertEquals(16000, policy.completed("litlife", 16000, cooldown, quiet, true));
    }
    @Test public void eachSourceRecoversIndependently() {
        DownloadPacing policy = new DownloadPacing();
        for (int i = 0; i < 7; i++) policy.completed("litlife", 16000, cooldown, quiet, true);
        assertEquals(8000, policy.completed("ranobelib", 8000, cooldown, quiet, true));
        assertEquals(8000, policy.completed("litlife", 16000, cooldown, quiet, true));
        assertEquals(8000, policy.completed("ranobelib", 8000, cooldown, quiet, true));
    }
    @Test public void restartAndExternalPolicyChangesConservativelyResetTheStreak() {
        DownloadPacing policy = new DownloadPacing();
        for (int i = 0; i < 7; i++) policy.completed("litlife", 16000, cooldown, quiet, true);
        assertEquals(16000, new DownloadPacing().completed("litlife", 16000, cooldown, quiet, true));
        assertEquals(30000, policy.completed("litlife", 30000, cooldown, quiet, true));
        assertEquals(16000, policy.completed("litlife", 16000, cooldown + 1, quiet + 1, true));
    }
    @Test public void corruptOrExtremePacingAndCooldownValuesRemainBounded() {
        assertEquals(1000, DownloadPacing.normalized(-1)); assertEquals(30000, DownloadPacing.normalized(Long.MAX_VALUE));
        assertEquals(16000, new DownloadPacing().completed("litlife", 16000, Long.MAX_VALUE, Long.MAX_VALUE - 1, true));
    }
}
