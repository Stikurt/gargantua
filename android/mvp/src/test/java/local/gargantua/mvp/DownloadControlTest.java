package local.gargantua.mvp;

import org.junit.Test;
import java.util.ArrayDeque;
import java.util.Queue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

public class DownloadControlTest {
    private static final class MainQueue implements Executor {
        final Queue<Runnable> values = new ArrayDeque<>();
        @Override public synchronized void execute(Runnable value) { values.add(value); }
        synchronized Runnable next() { return values.remove(); }
    }
    @Test public void waitingForAnImportDoesNotBlockTheCallerOrStartOnAStorageThread() throws Exception {
        ExecutorService storage = Executors.newSingleThreadExecutor(); MainQueue foreground = new MainQueue();
        CountDownLatch reading = new CountDownLatch(1), commit = new CountDownLatch(1), delivered = new CountDownLatch(1);
        AtomicReference<Thread> readThread = new AtomicReference<>(), startThread = new AtomicReference<>();
        Thread ui = Thread.currentThread();
        try {
            new DownloadControl(storage, foreground).requestStart(() -> {
                readThread.set(Thread.currentThread()); reading.countDown();
                try { if (!commit.await(3, TimeUnit.SECONDS)) throw new IllegalStateException("test commit timeout"); } catch (InterruptedException error) { throw new IllegalStateException(error); }
                return true;
            }, () -> true, () -> startThread.set(Thread.currentThread()), () -> fail("active queue"), error -> { assertNull(error); delivered.countDown(); });
            assertTrue(reading.await(1, TimeUnit.SECONDS)); assertNotSame(ui, readThread.get()); assertNull(startThread.get());
            // UI can do work while the simulated atomic import still owns the store.
            assertEquals(1, commit.getCount()); commit.countDown();
            storage.shutdown(); assertTrue(storage.awaitTermination(1, TimeUnit.SECONDS));
            assertEquals(1, delivered.getCount()); foreground.next().run();
            assertSame(ui, startThread.get()); assertEquals(0, delivered.getCount());
        } finally { commit.countDown(); storage.shutdownNow(); }
    }
    @Test public void backgroundingDuringTheDatabaseWaitDefersStartUntilANewVisibleRequest() {
        MainQueue storage = new MainQueue(), foreground = new MainQueue(); AtomicBoolean visible = new AtomicBoolean(true), started = new AtomicBoolean();
        DownloadControl control = new DownloadControl(storage, foreground);
        control.requestStart(() -> true, visible::get, () -> started.set(true), () -> fail("active queue"), error -> assertNull(error));
        storage.next().run(); visible.set(false); foreground.next().run(); assertFalse(started.get());
        visible.set(true);
        control.requestStart(() -> true, visible::get, () -> started.set(true), () -> fail("active queue"), error -> assertNull(error));
        storage.next().run(); foreground.next().run(); assertTrue(started.get());
    }
    @Test public void resumingWhileImportIsBlockedStartsAfterCommitWithoutAnotherUserAction() {
        MainQueue storage = new MainQueue(), foreground = new MainQueue(); AtomicBoolean started = new AtomicBoolean();
        new DownloadControl(storage, foreground).requestStart(() -> true, () -> true, () -> started.set(true), () -> fail("active queue"), error -> assertNull(error));
        assertFalse(started.get()); storage.next().run(); assertFalse(started.get()); foreground.next().run(); assertTrue(started.get());
    }
    @Test public void intentionallyPausedOrCompletedJobsDoNotStartAService() {
        MainQueue storage = new MainQueue(), foreground = new MainQueue(); AtomicBoolean snapshot = new AtomicBoolean();
        new DownloadControl(storage, foreground).requestStart(() -> false, () -> true, () -> fail("inactive queue must stay stopped"), () -> snapshot.set(true), error -> assertNull(error));
        storage.next().run(); foreground.next().run(); assertTrue(snapshot.get());
    }
    @Test public void storageAndAndroidStartFailuresReachTheForegroundReply() {
        for (boolean storageFailure : new boolean[]{true, false}) {
            MainQueue storage = new MainQueue(), foreground = new MainQueue(); RuntimeException expected = new IllegalStateException("test failure"); AtomicReference<RuntimeException> result = new AtomicReference<>();
            new DownloadControl(storage, foreground).requestStart(() -> { if (storageFailure) throw expected; return true; }, () -> true, () -> { throw expected; }, () -> fail("active queue"), result::set);
            storage.next().run(); assertNull(result.get()); foreground.next().run(); assertSame(expected, result.get());
        }
    }
    @Test public void progressAndPauseControlWorkIsQueuedWithoutReadingStorageOnTheCaller() {
        MainQueue storage = new MainQueue(), foreground = new MainQueue(); AtomicBoolean touched = new AtomicBoolean();
        new DownloadControl(storage, foreground).execute(() -> touched.set(true));
        assertFalse(touched.get()); storage.next().run(); assertTrue(touched.get()); assertTrue(foreground.values.isEmpty());
    }
}
