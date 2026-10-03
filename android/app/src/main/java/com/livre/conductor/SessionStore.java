package com.livre.conductor;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

/** Persists only a validated HTTPS API session for the native service. */
public final class SessionStore {
    private static final String PREFS = "livre";
    private static final String TOKEN = "token";
    private static final String API = "api";
    private static final String INVALIDATED = "session_invalidated";

    private SessionStore() {}

    public static synchronized boolean save(Context context, String token, String api) {
        if (!isValid(token, api)) {
            clear(context);
            return false;
        }
        preferences(context).edit()
                .putString(TOKEN, token)
                .putString(API, normalizeApi(api))
                .remove(INVALIDATED)
                .apply();
        return true;
    }

    public static synchronized Session read(Context context) {
        SharedPreferences prefs = preferences(context);
        String token = prefs.getString(TOKEN, null);
        String api = prefs.getString(API, null);
        if (!isValid(token, api)) {
            prefs.edit().clear().apply();
            return null;
        }
        return new Session(token, normalizeApi(api));
    }

    public static synchronized void clear(Context context) {
        preferences(context).edit().clear().apply();
    }

    public static synchronized void invalidate(Context context) {
        preferences(context).edit().clear().putBoolean(INVALIDATED, true).commit();
    }

    public static synchronized boolean consumeInvalidation(Context context) {
        SharedPreferences prefs = preferences(context);
        boolean invalidated = prefs.getBoolean(INVALIDATED, false);
        if (invalidated) prefs.edit().remove(INVALIDATED).commit();
        return invalidated;
    }

    public static synchronized boolean isValid(Context context) {
        return read(context) != null;
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static boolean isValid(String token, String api) {
        if (token == null || token.trim().isEmpty() || api == null || api.trim().isEmpty()) return false;
        try {
            Uri uri = Uri.parse(api.trim());
            return "https".equalsIgnoreCase(uri.getScheme())
                    && uri.getHost() != null
                    && uri.getUserInfo() == null
                    && uri.getFragment() == null;
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static String normalizeApi(String api) {
        String value = api.trim();
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }

    public static final class Session {
        public final String token;
        public final String api;

        private Session(String token, String api) {
            this.token = token;
            this.api = api;
        }
    }
}
