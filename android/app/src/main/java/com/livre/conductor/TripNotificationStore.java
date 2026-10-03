package com.livre.conductor;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Iterator;

/** Persistent, process-safe reservation store for trip notifications. */
public final class TripNotificationStore {
    private static final String PREFS = "livre";
    private static final String KEY = "notified_trip_ids_v2";
    private static final String LEGACY_KEY = "notified_trip_ids";
    private static final long RETENTION_MS = 7L * 24L * 60L * 60L * 1000L;
    private static final int MAX_ENTRIES = 500;

    private TripNotificationStore() {}

    public static synchronized boolean reserve(Context context, String tripId, long now) {
        if (tripId == null || tripId.trim().isEmpty()) return false;
        JSONObject entries = read(context);
        prune(entries, now);
        if (entries.has(tripId)) {
            write(context, entries);
            return false;
        }
        try {
            entries.put(tripId, now);
        } catch (JSONException ignored) {
            return false;
        }
        trimOldest(entries);
        return write(context, entries);
    }

    public static synchronized void clear(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).commit();
    }

    private static JSONObject read(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY, null);
        if (raw == null) {
            JSONObject migrated = new JSONObject();
            for (String id : prefs.getStringSet(LEGACY_KEY, java.util.Collections.emptySet())) {
                try { migrated.put(id, System.currentTimeMillis()); } catch (JSONException ignored) { return new JSONObject(); }
            }
            return migrated;
        }
        try {
            return new JSONObject(raw == null ? "{}" : raw);
        } catch (JSONException ignored) {
            return new JSONObject();
        }
    }

    private static boolean write(Context context, JSONObject entries) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY, entries.toString()).remove(LEGACY_KEY).commit();
    }

    private static void prune(JSONObject entries, long now) {
        Iterator<String> ids = entries.keys();
        while (ids.hasNext()) {
            String id = ids.next();
            long timestamp = entries.optLong(id, 0L);
            if (timestamp <= 0L || now - timestamp >= RETENTION_MS) ids.remove();
        }
    }

    private static void trimOldest(JSONObject entries) {
        while (entries.length() > MAX_ENTRIES) {
            String oldestId = null;
            long oldestTimestamp = Long.MAX_VALUE;
            Iterator<String> ids = entries.keys();
            while (ids.hasNext()) {
                String id = ids.next();
                long timestamp = entries.optLong(id, 0L);
                if (timestamp < oldestTimestamp) {
                    oldestTimestamp = timestamp;
                    oldestId = id;
                }
            }
            if (oldestId == null) return;
            entries.remove(oldestId);
        }
    }
}
