package dev.vortexaxis.quest.core;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicBoolean;

/** The core's WebSocket over the JDK's own client, for the tests (the app uses OkHttp). It answers pings by itself. */
final class JdkSockets implements Sockets {
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();

    @Override public Socket open(String url, Events events) {
        AtomicBoolean over = new AtomicBoolean();
        Holder h = new Holder();
        Socket socket = new Socket() {
            @Override public boolean send(String text) {
                WebSocket ws = h.ws;
                if (ws == null || over.get()) return false;
                synchronized (h) {
                    try {
                        ws.sendText(text, true).get();
                        return true;
                    } catch (Exception e) {
                        return false;
                    }
                }
            }

            @Override public void close(int code, String reason) {
                WebSocket ws = h.ws;
                if (ws != null) ws.sendClose(code, reason);
            }

            @Override public void cancel() {
                WebSocket ws = h.ws;
                if (ws != null) ws.abort();
                if (over.compareAndSet(false, true)) events.closed(1006, "cancelled", null);
            }
        };
        http.newWebSocketBuilder().buildAsync(URI.create(url), new WebSocket.Listener() {
            final StringBuilder text = new StringBuilder();

            @Override public void onOpen(WebSocket ws) {
                h.ws = ws;
                events.opened(socket);
                ws.request(1);
            }

            @Override public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
                text.append(data);
                if (last) {
                    String t = text.toString();
                    text.setLength(0);
                    events.text(t);
                }
                ws.request(1);
                return null;
            }

            @Override public CompletionStage<?> onBinary(WebSocket ws, ByteBuffer data, boolean last) {
                ws.request(1);
                return null;
            }

            @Override public CompletionStage<?> onClose(WebSocket ws, int code, String reason) {
                if (over.compareAndSet(false, true)) events.closed(code, reason, null);
                return CompletableFuture.completedFuture(null);
            }

            @Override public void onError(WebSocket ws, Throwable error) {
                if (over.compareAndSet(false, true)) events.closed(1006, null, error);
            }
        }).whenComplete((ws, error) -> {
            if (error != null && over.compareAndSet(false, true)) events.closed(1006, null, error.getCause() != null ? error.getCause() : error);
        });
        return socket;
    }

    private static final class Holder {
        volatile WebSocket ws;
    }
}
