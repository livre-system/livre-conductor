package com.livre.conductor;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;
import java.net.SocketTimeoutException;
import javax.net.ssl.SSLException;
import java.util.Locale;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public class LocationService extends Service {
    private static final String LOCATION_CHANNEL = "livre_location";
    private static final String TRIP_CHANNEL = "livre_trips";
    private static final int FOREGROUND_ID = 7;

    private LocationManager manager;
    private String token;
    private String api;
    private boolean appVisible = false;
    private boolean networkAvailable;
    private long retryNotBefore;
    private long retryDelayMs = 5000L;
    private final ScheduledExecutorService network = Executors.newScheduledThreadPool(1);
    private final AtomicBoolean pollRunning = new AtomicBoolean(false);
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback connectivityCallback;
    private ScheduledFuture<?> tripPoll;
    private final LocationListener listener = new LocationListener() {
        @Override public void onLocationChanged(Location location) { sendLocation(location); }
    };

    @Override public void onCreate() {
        super.onCreate();
        createChannels();
        manager = (LocationManager) getSystemService(LOCATION_SERVICE);
        connectivity = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            if (intent.hasExtra("token")) token = intent.getStringExtra("token");
            if (intent.hasExtra("api")) api = intent.getStringExtra("api");
            if (intent.hasExtra("app_visible")) appVisible = intent.getBooleanExtra("app_visible", true);
        }
        SessionStore.Session session = SessionStore.read(this);
        if (session == null || !PermissionGate.operational(this)) {
            token = null;
            api = null;
            stopSelf();
            return START_NOT_STICKY;
        }
        token = session.token;
        api = session.api;
        if (tripPoll == null) {
            startForeground(FOREGROUND_ID, notification());
            networkAvailable = hasValidatedNetwork();
            registerConnectivityCallback();
            tripPoll = network.scheduleWithFixedDelay(this::pollTripsIfBackground, 2, 5, TimeUnit.SECONDS);
        }
        requestUpdates();
        return START_STICKY;
    }

    private void requestUpdates() {
        if (manager == null || token == null || api == null || !PermissionGate.operational(this)) return;
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return;
        try {
            if (manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 10000L, 10f, listener, Looper.getMainLooper());
            if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) manager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 15000L, 25f, listener, Looper.getMainLooper());
        } catch (SecurityException ignored) {}
    }

    private void sendLocation(Location location) {
        final String currentToken = token;
        final String currentApi = api;
        if (currentToken == null || currentApi == null || !PermissionGate.operational(this)) {
            if (!PermissionGate.operational(this)) stopSelf();
            return;
        }
        network.execute(() -> {
            String activeTripId = null;
            try {
                postLocation(currentApi, currentToken, "/mobility/driver/location", location);
                JSONArray trips = getTrips(currentApi, currentToken);
                if (trips != null) {
                    activeTripId = findActiveTripId(trips);
                    if (!appVisible) notifyNewAssignedTrips(trips);
                }
                if (activeTripId != null) postLocation(currentApi, currentToken, "/mobility/driver/trips/" + encodePath(activeTripId) + "/location", location);
            } catch (RequestFailure e) {
                handleRequestFailure(e);
            } catch (Exception ignored) {
            }
        });
    }

    private void pollTripsIfBackground() {
        if (!PermissionGate.operational(this)) {
            stopSelf();
            return;
        }
        if (appVisible || token == null || api == null || !networkAvailable) return;
        if (System.currentTimeMillis() < retryNotBefore) return;
        if (!pollRunning.compareAndSet(false, true)) return;
        try {
            JSONArray trips = getTrips(api, token);
            if (trips != null) {
                notifyNewAssignedTrips(trips);
                resetRetryBackoff();
            }
        } catch (RequestFailure e) {
            handleRequestFailure(e);
        } catch (Exception ignored) {
            scheduleRetry();
        } finally {
            pollRunning.set(false);
        }
    }

    private void pollImmediately() {
        if (networkAvailable && !appVisible && token != null && api != null) {
            retryNotBefore = 0L;
            network.execute(this::pollTripsIfBackground);
        }
    }

    private void resetRetryBackoff() {
        retryDelayMs = 5000L;
        retryNotBefore = 0L;
    }

    private void scheduleRetry() {
        retryNotBefore = System.currentTimeMillis() + retryDelayMs;
        retryDelayMs = Math.min(retryDelayMs * 2L, 60000L);
    }

    private void handleRequestFailure(RequestFailure failure) {
        switch (failure.kind) {
            case UNAUTHORIZED:
            case FORBIDDEN:
                clearCredentialsAndStop();
                break;
            case TIMEOUT:
            case DNS_TLS:
            case SERVER:
                scheduleRetry();
                break;
            default:
                break;
        }
    }

    private boolean hasValidatedNetwork() {
        if (connectivity == null) return false;
        Network active = connectivity.getActiveNetwork();
        if (active == null) return false;
        NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(active);
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    private void registerConnectivityCallback() {
        if (connectivity == null || Build.VERSION.SDK_INT < 21) return;
        connectivityCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                boolean wasAvailable = networkAvailable;
                networkAvailable = hasValidatedNetwork();
                if (!wasAvailable && networkAvailable) pollImmediately();
            }

            @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                boolean validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                boolean wasAvailable = networkAvailable;
                networkAvailable = validated;
                if (!wasAvailable && validated) pollImmediately();
            }

            @Override public void onLost(Network network) {
                networkAvailable = hasValidatedNetwork();
            }
        };
        try {
            if (Build.VERSION.SDK_INT >= 24) {
                connectivity.registerDefaultNetworkCallback(connectivityCallback);
            } else {
                NetworkRequest request = new NetworkRequest.Builder()
                        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        .build();
                connectivity.registerNetworkCallback(request, connectivityCallback);
            }
        } catch (RuntimeException ignored) {
            connectivityCallback = null;
        }
    }

    private JSONArray getTrips(String currentApi, String currentToken) throws RequestFailure {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(trimApi(currentApi) + "/mobility/driver/trips?_=" + System.currentTimeMillis());
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(4500);
            connection.setReadTimeout(4500);
            connection.setRequestProperty("Authorization", "Bearer " + currentToken);
            int status = connection.getResponseCode();
            if (status == 401) throw new RequestFailure(RequestFailure.Kind.UNAUTHORIZED);
            if (status == 403) throw new RequestFailure(RequestFailure.Kind.FORBIDDEN);
            if (status == 408) throw new RequestFailure(RequestFailure.Kind.TIMEOUT);
            if (status >= 500 && status < 600) throw new RequestFailure(RequestFailure.Kind.SERVER);
            if (status < 200 || status >= 300) throw new RequestFailure(RequestFailure.Kind.OTHER);
            return new JSONArray(readBody(connection.getInputStream()));
        } catch (SocketTimeoutException e) {
            throw new RequestFailure(RequestFailure.Kind.TIMEOUT, e);
        } catch (UnknownHostException | SSLException e) {
            throw new RequestFailure(RequestFailure.Kind.DNS_TLS, e);
        } catch (RequestFailure e) {
            throw e;
        } catch (Exception e) {
            throw new RequestFailure(RequestFailure.Kind.OTHER, e);
        } finally { if (connection != null) connection.disconnect(); }
    }

    private void postLocation(String currentApi, String currentToken, String path, Location location) throws RequestFailure {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(trimApi(currentApi) + path);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + currentToken);
            connection.setRequestProperty("Content-Type", "application/json");
            String body = String.format(Locale.US, "{\"latitude\":%.7f,\"longitude\":%.7f,\"accuracy\":%.2f}", location.getLatitude(), location.getLongitude(), location.getAccuracy());
            try (OutputStream out = connection.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
            int status = connection.getResponseCode();
            if (status == 401) throw new RequestFailure(RequestFailure.Kind.UNAUTHORIZED);
            if (status == 403) throw new RequestFailure(RequestFailure.Kind.FORBIDDEN);
            if (status >= 500 && status < 600) throw new RequestFailure(RequestFailure.Kind.SERVER);
            if (status < 200 || status >= 300) throw new RequestFailure(RequestFailure.Kind.OTHER);
        } catch (SocketTimeoutException e) {
            throw new RequestFailure(RequestFailure.Kind.TIMEOUT, e);
        } catch (UnknownHostException | SSLException e) {
            throw new RequestFailure(RequestFailure.Kind.DNS_TLS, e);
        } catch (RequestFailure e) {
            throw e;
        } catch (Exception e) {
            throw new RequestFailure(RequestFailure.Kind.OTHER, e);
        } finally { if (connection != null) connection.disconnect(); }
    }

    private void notifyNewAssignedTrips(JSONArray trips) {
        if (!tripNotificationsEnabled()) return;
        long now = System.currentTimeMillis();
        for (int i = 0; i < trips.length(); i++) {
            JSONObject trip = trips.optJSONObject(i);
            if (trip == null || !"assigned".equals(trip.optString("status"))) continue;
            String id = trip.optString("id", "");
            if (id.isEmpty() || !TripNotificationStore.reserve(this, id, now)) continue;
            notifyTrip(id, trip);
        }
    }

    private boolean tripNotificationsEnabled() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT >= 24 && !manager.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = manager.getNotificationChannel(TRIP_CHANNEL);
            return channel != null && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
        }
        return true;
    }

    private String findActiveTripId(JSONArray trips) {
        for (int i = 0; i < trips.length(); i++) {
            JSONObject trip = trips.optJSONObject(i);
            if (trip == null) continue;
            String status = trip.optString("status");
            if ("arriving".equals(status) || "in_progress".equals(status)) return trip.optString("id", null);
        }
        return null;
    }

    private void notifyTrip(String id, JSONObject trip) {
        Intent open = new Intent(this, MainActivity.class)
                .putExtra("trip_id", id)
                .setData(Uri.parse("livre://trip/" + Uri.encode(id)))
                .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int requestCode = id.hashCode();
        PendingIntent pending = PendingIntent.getActivity(this, requestCode, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, TRIP_CHANNEL) : new Notification.Builder(this);
        String origin = trip.optString("origin", "Origen disponible");
        String destination = trip.optString("destination", "Destino disponible");
        Notification notification = builder.setContentTitle("Nuevo viaje disponible")
                .setContentText(origin + " → " + destination)
                .setSmallIcon(com.livre.conductor.R.drawable.ic_launcher)
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_CALL)
                .setPriority(Notification.PRIORITY_HIGH)
                .setVibrate(new long[]{0, 350, 180, 700})
                .setSound(Uri.parse("android.resource://" + getPackageName() + "/" + com.livre.conductor.R.raw.trip_horn))
                .build();
        getSystemService(NotificationManager.class).notify(requestCode, notification);
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel location = new NotificationChannel(LOCATION_CHANNEL, "Ubicación de Livre", NotificationManager.IMPORTANCE_LOW);
        location.setDescription("Mantiene activa la ubicación del conductor");
        manager.createNotificationChannel(location);
        Uri sound = Uri.parse("android.resource://" + getPackageName() + "/" + com.livre.conductor.R.raw.trip_horn);
        AudioAttributes audio = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
        NotificationChannel trips = new NotificationChannel(TRIP_CHANNEL, "Nuevos viajes", NotificationManager.IMPORTANCE_HIGH);
        trips.setDescription("Avisa cuando hay un viaje nuevo asignado");
        trips.enableVibration(true);
        trips.setVibrationPattern(new long[]{0, 350, 180, 700});
        trips.setSound(sound, audio);
        manager.createNotificationChannel(trips);
    }

    private Notification notification() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, LOCATION_CHANNEL) : new Notification.Builder(this);
        return builder.setContentTitle("Livre: ubicación activa").setContentText("La ubicación se comparte para seguridad, incluso en segundo plano.").setSmallIcon(com.livre.conductor.R.drawable.ic_launcher).setContentIntent(pending).setOngoing(true).build();
    }

    private void clearCredentialsAndStop() {
        SessionStore.invalidate(this);
        token = null;
        api = null;
        sendBroadcast(new Intent(MainActivity.ACTION_SESSION_INVALIDATED)
                .setPackage(getPackageName()));
        stopSelf();
    }

    private static String trimApi(String value) { return value.replaceAll("/$", ""); }
    private static String encodePath(String value) { return value.replace("/", "%2F"); }
    private static String readBody(InputStream input) throws Exception {
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line; while ((line = reader.readLine()) != null) result.append(line);
        }
        return result.toString();
    }
    private static class RequestFailure extends Exception {
        enum Kind { UNAUTHORIZED, FORBIDDEN, TIMEOUT, DNS_TLS, SERVER, OTHER }
        final Kind kind;

        RequestFailure(Kind kind) {
            this.kind = kind;
        }

        RequestFailure(Kind kind, Throwable cause) {
            super(cause);
            this.kind = kind;
        }
    }

    @Override public void onDestroy() {
        if (manager != null) manager.removeUpdates(listener);
        if (tripPoll != null) tripPoll.cancel(true);
        if (connectivity != null && connectivityCallback != null && Build.VERSION.SDK_INT >= 21) {
            try { connectivity.unregisterNetworkCallback(connectivityCallback); } catch (RuntimeException ignored) {}
        }
        network.shutdownNow();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
