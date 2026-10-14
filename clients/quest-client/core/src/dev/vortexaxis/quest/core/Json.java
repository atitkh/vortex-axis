package dev.vortexaxis.quest.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Just enough JSON for protocol 1: objects are LinkedHashMap, arrays ArrayList, numbers Long when
 * whole and Double otherwise, plus String, Boolean and null. No library, so the core runs the same
 * on Android and on a plain JVM.
 */
public final class Json {
    private Json() {}

    public static Object parse(String text) {
        Reader r = new Reader(text);
        r.space();
        Object value = r.value();
        r.space();
        if (r.at < text.length()) throw new IllegalArgumentException("trailing characters at " + r.at);
        return value;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String text) {
        Object v = parse(text);
        if (!(v instanceof Map)) throw new IllegalArgumentException("not a JSON object");
        return (Map<String, Object>) v;
    }

    public static String write(Object value) {
        StringBuilder sb = new StringBuilder();
        write(sb, value);
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static void write(StringBuilder sb, Object v) {
        if (v == null) sb.append("null");
        else if (v instanceof String) quote(sb, (String) v);
        else if (v instanceof Boolean) sb.append(v);
        else if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) sb.append("null");
            else if (d == Math.rint(d) && Math.abs(d) < 1e15) sb.append((long) d);
            else sb.append(d);
        } else if (v instanceof Number) sb.append(((Number) v).longValue());
        else if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                quote(sb, e.getKey());
                sb.append(':');
                write(sb, e.getValue());
            }
            sb.append('}');
        } else if (v instanceof List) {
            sb.append('[');
            boolean first = true;
            for (Object o : (List<Object>) v) {
                if (!first) sb.append(',');
                first = false;
                write(sb, o);
            }
            sb.append(']');
        } else quote(sb, v.toString());
    }

    private static void quote(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
    }

    /** A fresh object, for building messages: `Json.obj("t", "hello", "protocol", 1)`. */
    public static Map<String, Object> obj(Object... keyValues) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < keyValues.length; i += 2) m.put((String) keyValues[i], keyValues[i + 1]);
        return m;
    }

    // ---- reading values out of parsed JSON ---------------------------------

    /** A non-empty string at `key`, else null. */
    public static String str(Map<String, Object> m, String key) {
        Object v = m == null ? null : m.get(key);
        return v instanceof String && !((String) v).isEmpty() ? (String) v : null;
    }

    /** A number at `key`, rounded, else null. */
    public static Integer integer(Map<String, Object> m, String key) {
        Object v = m == null ? null : m.get(key);
        return v instanceof Number ? (int) Math.round(((Number) v).doubleValue()) : null;
    }

    public static boolean isTrue(Map<String, Object> m, String key) {
        return m != null && Boolean.TRUE.equals(m.get(key));
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> map(Object v) {
        return v instanceof Map ? (Map<String, Object>) v : null;
    }

    @SuppressWarnings("unchecked")
    public static List<Object> list(Object v) {
        return v instanceof List ? (List<Object>) v : null;
    }

    private static final class Reader {
        final String s;
        int at;

        Reader(String s) { this.s = s; }

        void space() {
            while (at < s.length() && Character.isWhitespace(s.charAt(at))) at++;
        }

        IllegalArgumentException bad(String what) {
            return new IllegalArgumentException(what + " at " + at);
        }

        Object value() {
            if (at >= s.length()) throw bad("unexpected end");
            char c = s.charAt(at);
            switch (c) {
                case '{': return object();
                case '[': return array();
                case '"': return string();
                case 't': word("true"); return Boolean.TRUE;
                case 'f': word("false"); return Boolean.FALSE;
                case 'n': word("null"); return null;
                default: return number();
            }
        }

        void word(String w) {
            if (!s.startsWith(w, at)) throw bad("expected " + w);
            at += w.length();
        }

        Map<String, Object> object() {
            Map<String, Object> m = new LinkedHashMap<>();
            at++;
            space();
            if (at < s.length() && s.charAt(at) == '}') { at++; return m; }
            while (true) {
                space();
                if (at >= s.length() || s.charAt(at) != '"') throw bad("expected a key");
                String key = string();
                space();
                if (at >= s.length() || s.charAt(at) != ':') throw bad("expected :");
                at++;
                space();
                m.put(key, value());
                space();
                if (at >= s.length()) throw bad("unexpected end");
                char c = s.charAt(at++);
                if (c == '}') return m;
                if (c != ',') throw bad("expected , or }");
            }
        }

        List<Object> array() {
            List<Object> l = new ArrayList<>();
            at++;
            space();
            if (at < s.length() && s.charAt(at) == ']') { at++; return l; }
            while (true) {
                space();
                l.add(value());
                space();
                if (at >= s.length()) throw bad("unexpected end");
                char c = s.charAt(at++);
                if (c == ']') return l;
                if (c != ',') throw bad("expected , or ]");
            }
        }

        String string() {
            at++;
            StringBuilder sb = new StringBuilder();
            while (true) {
                if (at >= s.length()) throw bad("unterminated string");
                char c = s.charAt(at++);
                if (c == '"') return sb.toString();
                if (c != '\\') { sb.append(c); continue; }
                if (at >= s.length()) throw bad("unterminated escape");
                char e = s.charAt(at++);
                switch (e) {
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case '/': sb.append('/'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'n': sb.append('\n'); break;
                    case 'r': sb.append('\r'); break;
                    case 't': sb.append('\t'); break;
                    case 'u':
                        if (at + 4 > s.length()) throw bad("short \\u escape");
                        sb.append((char) Integer.parseInt(s.substring(at, at + 4), 16));
                        at += 4;
                        break;
                    default: throw bad("bad escape");
                }
            }
        }

        Object number() {
            int start = at;
            if (at < s.length() && (s.charAt(at) == '-' || s.charAt(at) == '+')) at++;
            boolean whole = true;
            while (at < s.length()) {
                char c = s.charAt(at);
                if (c >= '0' && c <= '9') at++;
                else if (c == '.' || c == 'e' || c == 'E' || c == '-' || c == '+') { whole = false; at++; }
                else break;
            }
            String n = s.substring(start, at);
            if (n.isEmpty()) throw bad("unexpected character");
            try {
                if (whole) return Long.parseLong(n);
                return Double.parseDouble(n);
            } catch (NumberFormatException ex) {
                throw bad("bad number");
            }
        }
    }
}
