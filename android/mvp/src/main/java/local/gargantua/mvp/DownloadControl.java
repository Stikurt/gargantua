package local.gargantua.mvp;

import java.util.concurrent.Executor;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** Database checks may wait for an import; lifecycle eligibility is checked on delivery. */
final class DownloadControl {
    private final Executor storage, foreground;
    DownloadControl(Executor storage, Executor foreground) { this.storage = storage; this.foreground = foreground; }
    void execute(Runnable work) { storage.execute(work); }
    void requestStart(BooleanSupplier active, BooleanSupplier visible, Runnable start, Runnable idle, Consumer<RuntimeException> complete) {
        storage.execute(() -> {
            final boolean pending;
            try { pending = active.getAsBoolean(); }
            catch (RuntimeException error) { foreground.execute(() -> complete.accept(error)); return; }
            foreground.execute(() -> {
                try {
                    if (pending && visible.getAsBoolean()) start.run();
                    else if (!pending) idle.run();
                    complete.accept(null);
                } catch (RuntimeException error) { complete.accept(error); }
            });
        });
    }
}
