package com.livre.conductor;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class LocationService extends Service {
    private static final String CHANNEL = "livre_location";
    private LocationManager manager;
    private String token;
    private String api;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final LocationListener listener = new LocationListener() {
        @Override public void onLocationChanged(Location location) { sendLocation(location); }
    };

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(7, notification());
        manager = (LocationManager) getSystemService(LOCATION_SERVICE);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            if (intent.hasExtra("token")) token = intent.getStringExtra("token");
            if (intent.hasExtra("api")) api = intent.getStringExtra("api");
        }
        if (token == null || api == null) {
            android.content.SharedPreferences p = getSharedPreferences("livre", MODE_PRIVATE);
            token = p.getString("token", null);
            api = p.getString("api", null);
        }
        requestUpdates();
        return START_STICKY;
    }

    private void requestUpdates() {
        if (manager == null || token == null || api == null) return;
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED && checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) return;
        try {
            if (manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 10000L, 10f, listener, Looper.getMainLooper());
            if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) manager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 15000L, 25f, listener, Looper.getMainLooper());
        } catch (SecurityException ignored) {}
    }

    private void sendLocation(Location location) {
        final String currentToken = token;
        final String currentApi = api;
        if (currentToken == null || currentApi == null) return;
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(currentApi.replaceAll("/$", "") + "/mobility/driver/location");
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(10000);
                connection.setReadTimeout(10000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Authorization", "Bearer " + currentToken);
                connection.setRequestProperty("Content-Type", "application/json");
                String body = String.format(Locale.US, "{\"latitude\":%.7f,\"longitude\":%.7f,\"accuracy\":%.2f}", location.getLatitude(), location.getLongitude(), location.getAccuracy());
                try (OutputStream out = connection.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
                connection.getResponseCode();
            } catch (Exception ignored) {
            } finally { if (connection != null) connection.disconnect(); }
        });
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Ubicación de Livre", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Mantiene activa la ubicación del conductor");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    private Notification notification() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return builder.setContentTitle("Livre: ubicación activa").setContentText("La ubicación se comparte para seguridad, incluso en segundo plano.").setSmallIcon(com.livre.conductor.R.drawable.ic_launcher).setContentIntent(pending).setOngoing(true).build();
    }

    @Override public void onDestroy() {
        if (manager != null) manager.removeUpdates(listener);
        network.shutdownNow();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
