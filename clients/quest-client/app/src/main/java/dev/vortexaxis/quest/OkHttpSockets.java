package dev.vortexaxis.quest;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import dev.vortexaxis.quest.core.Sockets;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * The core's WebSocket over OkHttp. A ping every 20 seconds, as the Windows app's KeepAliveInterval,
 * so a connection that died quietly (Wi-Fi gone, the headset asleep) is noticed; OkHttp answers
 * Axis's own pings. No android.* here, so the end-to-end test can run it on a plain JVM too.
 */
public final class OkHttpSockets implements Sockets {
    private final OkHttpClient http = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build();

    @Override public Socket open(String url, Events events) {
        AtomicBoolean over = new AtomicBoolean();
        WebSocket[] holder = new WebSocket[1];
        Socket socket = new Socket() {
            @Override public boolean send(String text) {
                WebSocket ws = holder[0];
                return ws != null && !over.get() && ws.send(text);
            }

            @Override public void close(int code, String reason) {
                WebSocket ws = holder[0];
                if (ws != null) ws.close(code, reason);
            }

            @Override public void cancel() {
                WebSocket ws = holder[0];
                if (ws != null) ws.cancel();
                if (over.compareAndSet(false, true)) events.closed(1006, "cancelled", null);
            }
        };
        holder[0] = http.newWebSocket(new Request.Builder().url(url).build(), new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response response) {
                holder[0] = ws;
                events.opened(socket);
            }

            @Override public void onMessage(WebSocket ws, String text) {
                events.text(text);
            }

            @Override public void onClosing(WebSocket ws, int code, String reason) {
                ws.close(code, null);
                if (over.compareAndSet(false, true)) events.closed(code, reason, null);
            }

            @Override public void onClosed(WebSocket ws, int code, String reason) {
                if (over.compareAndSet(false, true)) events.closed(code, reason, null);
            }

            @Override public void onFailure(WebSocket ws, Throwable t, Response response) {
                if (over.compareAndSet(false, true)) events.closed(1006, null, t);
            }
        });
        return socket;
    }
}
