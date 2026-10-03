package com.livre.conductor;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Build;

/** Single permission/lifecycle gate shared by the Activity and service. */
public final class PermissionGate {
    public enum State {
        READY,
        NEED_PRECISE_LOCATION,
        NEED_BACKGROUND_LOCATION,
        NEED_NOTIFICATIONS,
        LOCATION_DISABLED
    }

    private PermissionGate() {}

    public static State evaluate(Context context) {
        if (Build.VERSION.SDK_INT >= 23
                && context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            return State.NEED_PRECISE_LOCATION;
        }
        if (Build.VERSION.SDK_INT >= 29
                && context.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            return State.NEED_BACKGROUND_LOCATION;
        }
        if (!notificationsEnabled(context)) return State.NEED_NOTIFICATIONS;
        if (!locationProviderEnabled(context)) return State.LOCATION_DISABLED;
        return State.READY;
    }

    public static boolean notificationsEnabled(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT >= 24 && !manager.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = manager.getNotificationChannel("livre_trips");
            if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return false;
        }
        return true;
    }

    public static boolean locationProviderEnabled(Context context) {
        LocationManager manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= 28) return manager.isLocationEnabled();
            return manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                    || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    public static boolean operational(Context context) {
        return evaluate(context) == State.READY;
    }
}
