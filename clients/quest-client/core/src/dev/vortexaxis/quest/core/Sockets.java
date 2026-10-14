package dev.vortexaxis.quest.core;

/**
 * A WebSocket, behind an interface so the core needs no library: the app gives it OkHttp, the JVM
 * tests the JDK's own client. Implementations keep the connection alive with WebSocket pings (the
 * Windows app's KeepAliveInterval) and answer Axis's pings.
 */
public interface Sockets {
    /** Opens `url`; events arrive on `events`, on any thread, one at a time. */
    Socket open(String url, Events events);

    interface Socket {
        /** Queues a text frame; false when the socket is closed or the frame could not be queued. */
        boolean send(String text);
        void close(int code, String reason);
        /** Drops the connection at once. */
        void cancel();
    }

    interface Events {
        /** Connected; `socket` is the same one open() returns (it may not have returned yet). */
        void opened(Socket socket);
        void text(String text);
        /** The connection ended; `reason` is the close reason Axis gave, or why it failed. Called once. */
        void closed(int code, String reason, Throwable failure);
    }
}
