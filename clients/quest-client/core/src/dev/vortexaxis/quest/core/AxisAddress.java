package dev.vortexaxis.quest.core;

import java.net.URI;
import java.net.URISyntaxException;

/**
 * Where Axis is, from whatever a person types: an address with or without its scheme, or a setup
 * string (axis://host:port/code, axis+tls:// for an encrypted address) that carries the pairing code
 * too. A port of the Windows app's AxisAddress.cs.
 */
public final class AxisAddress {
    public static final String PAIR_PATH = "/v1/pair";
    public static final String SOCKET_PATH = "/v1/client";

    /** The http(s) base, no path: "http://192.168.1.20:8440". */
    public final String http;
    /** The pairing code a setup string carried, else null. */
    public final String code;
    private final boolean tls;
    private final String authority;

    private AxisAddress(boolean tls, String authority, String code) {
        this.tls = tls;
        this.authority = authority;
        this.code = code;
        this.http = (tls ? "https://" : "http://") + authority;
    }

    public String pairUrl() { return http + PAIR_PATH; }

    public String socketUrl() { return (tls ? "wss://" : "ws://") + authority + SOCKET_PATH; }

    @Override public String toString() { return http; }

    /**
     * Reads an address. A bare host:port is taken as plain http (a hub on the local network); a bare
     * name as https (a hub under a public name). An explicit scheme wins.
     */
    public static AxisAddress parse(String input) {
        String text = input == null ? "" : input.trim();
        if (text.isEmpty()) throw new IllegalArgumentException("Give Axis's address.");
        String lower = text.toLowerCase(java.util.Locale.ROOT);
        String code = null;
        boolean tls;
        if (lower.startsWith("axis+tls://") || lower.startsWith("axis://")) {
            tls = lower.startsWith("axis+tls://");
            text = text.substring(text.indexOf("://") + 3);
            int slash = text.indexOf('/');
            if (slash >= 0) {
                code = trimSlashes(text.substring(slash + 1));
                if (code.isEmpty()) code = null;
                text = text.substring(0, slash);
            }
        } else if (lower.startsWith("http://") || lower.startsWith("https://")) {
            tls = lower.startsWith("https://");
            text = text.substring(text.indexOf("://") + 3);
            int slash = text.indexOf('/');
            if (slash >= 0) text = text.substring(0, slash);
        } else {
            int slash = text.indexOf('/');
            if (slash >= 0) text = text.substring(0, slash);
            tls = !text.contains(":");
        }
        URI uri;
        try {
            uri = new URI((tls ? "https" : "http") + "://" + text + "/");
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("\"" + input + "\" is not an address.");
        }
        if (uri.getHost() == null || uri.getHost().isEmpty() || uri.getUserInfo() != null)
            throw new IllegalArgumentException("\"" + input + "\" is not an address.");
        int port = uri.getPort();
        boolean defaultPort = port == -1 || (tls && port == 443) || (!tls && port == 80);
        String host = uri.getHost().toLowerCase(java.util.Locale.ROOT);
        return new AxisAddress(tls, defaultPort ? host : host + ":" + port, code);
    }

    private static String trimSlashes(String s) {
        int a = 0, b = s.length();
        while (a < b && s.charAt(a) == '/') a++;
        while (b > a && s.charAt(b - 1) == '/') b--;
        return s.substring(a, b);
    }
}
