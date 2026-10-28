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

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

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
    private static final String TAG = "LivreLocation";
    private static final String LOCATION_CHANNEL = "livre_location";
    // v3 intentionally replaces the old channel: Android persists channel
    // sound settings and will not repair a channel previously made silent.
    private static final String TRIP_CHANNEL = "livre_trips_v3";
    private static final int FOREGROUND_ID = 7;

    private LocationManager manager;
    private FusedLocationProviderClient fused;
    private boolean fusedCallbackReceived;
    private boolean gpsFallbackRequested;
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
        @Override public void onLocationChanged(Location location) {
            android.util.Log.i(TAG, "GPS fallback callback provider=" + location.getProvider()
                    + " accuracy_m=" + location.getAccuracy());
            sendLocation(location);
        }
    };
    private final LocationCallback fusedCallback = new LocationCallback() {
        @Override public void onLocationResult(LocationResult result) {
            if (result == null || result.getLastLocation() == null) {
                android.util.Log.w(TAG, "Fused callback sin ubicación");
                return;
            }
            fusedCallbackReceived = true;
            Location location = result.getLastLocation();
            android.util.Log.i(TAG, "Fused callback provider=" + location.getProvider()
                    + " accuracy_m=" + location.getAccuracy());
            sendLocation(location);
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        createChannels();
        manager = (LocationManager) getSystemService(LOCATION_SERVICE);
        fused = LocationServices.getFusedLocationProviderClient(this);
        connectivity = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String fallbackTripId = null;
        JSONObject fallbackTrip = null;
        if (intent != null) {
            if (intent.hasExtra("token")) token = intent.getStringExtra("token");
            if (intent.hasExtra("api")) api = intent.getStringExtra("api");
            if (intent.hasExtra("app_visible")) appVisible = intent.getBooleanExtra("app_visible", true);
            fallbackTripId = intent.getStringExtra("fallback_trip_id");
            if (fallbackTripId != null && !fallbackTripId.isEmpty()) {
                fallbackTrip = new JSONObject();
                try {
                    fallbackTrip.put("id", fallbackTripId);
                    fallbackTrip.put("status", "assigned");
                    fallbackTrip.put("origin", intent.getStringExtra("fallback_origin"));
                    fallbackTrip.put("destination", intent.getStringExtra("fallback_destination"));
                } catch (Exception ignored) { fallbackTrip = null; }
            }
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
        if (fallbackTripId != null && fallbackTrip != null) {
            final String id = fallbackTripId;
            final JSONObject trip = fallbackTrip;
            network.execute(() -> {
                if (!tripNotificationsEnabled() || !TripNotificationStore.reserve(this, id, System.currentTimeMillis())) return;
                try {
                    notifyTrip(id, trip);
                    TripNotificationStore.markNotified(this, id, System.currentTimeMillis());
                } catch (RuntimeException ignored) {
                    // Leave the reservation pending so the normal poll can retry it.
                }
            });
        }
        return START_STICKY;
    }

    private void requestUpdates() {
        if (manager == null || fused == null || token == null || api == null || !PermissionGate.operational(this)) {
            android.util.Log.w(TAG, "Solicitud omitida: sesión/permisos no operativos");
            return;
        }
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            android.util.Log.e(TAG, "Solicitud rechazada: ACCESS_FINE_LOCATION no concedido");
            return;
        }
        fusedCallbackReceived = false;
        gpsFallbackRequested = false;
        android.util.Log.i(TAG, "Solicitando Fused PRIORITY_HIGH_ACCURACY intervalo_ms=10000");
        try {
            LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 10000L)
                    .setMinUpdateIntervalMillis(5000L)
                    .setMinUpdateDistanceMeters(10f)
                    .build();
            fused.requestLocationUpdates(request, fusedCallback, Looper.getMainLooper())
                    .addOnSuccessListener(unused -> {
                        android.util.Log.i(TAG, "Solicitud Fused aceptada");
                        network.schedule(this::requestGpsFallbackIfNeeded, 20, TimeUnit.SECONDS);
                    })
                    .addOnFailureListener(error -> {
                        android.util.Log.e(TAG, "Error solicitando Fused: " + error.getClass().getSimpleName());
                        requestGpsFallback();
                    });
        } catch (SecurityException error) {
            android.util.Log.e(TAG, "Error de permisos al solicitar Fused: SecurityException");
            requestGpsFallback();
        } catch (RuntimeException error) {
            android.util.Log.e(TAG, "Error del proveedor Fused: " + error.getClass().getSimpleName());
            requestGpsFallback();
        }
    }

    private void requestGpsFallbackIfNeeded() {
        if (!fusedCallbackReceived) requestGpsFallback();
    }

    private void requestGpsFallback() {
        if (gpsFallbackRequested || manager == null) return;
        gpsFallbackRequested = true;
        try {
            if (manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                android.util.Log.w(TAG, "Fused sin callback: activando GPS_PROVIDER como fallback");
                manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 10000L, 10f, listener, Looper.getMainLooper());
            } else if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                android.util.Log.w(TAG, "GPS_PROVIDER no disponible: activando NETWORK_PROVIDER fallback");
                manager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 15000L, 100f, listener, Looper.getMainLooper());
            } else {
                android.util.Log.e(TAG, "Sin proveedor GPS/NETWORK habilitado");
            }
        } catch (SecurityException error) {
            android.util.Log.e(TAG, "Error de permisos en fallback: SecurityException");
        } catch (RuntimeException error) {
            android.util.Log.e(TAG, "Error del proveedor GPS fallback: " + error.getClass().getSimpleName());
        }
    }

    private void sendLocation(Location location) {
        final String currentToken = token;
        final String currentApi = api;
        if (currentToken == null || currentApi == null || !PermissionGate.operational(this)
                || !SessionStore.hasCurrentSession(this, currentToken, currentApi)) {
            if (!PermissionGate.operational(this)) stopSelf();
            return;
        }
        network.execute(() -> {

            String activeTripId = null;
            try {
                if (!SessionStore.hasCurrentSession(this, currentToken, currentApi)) return;
                postLocation(currentApi, currentToken, sessionDeviceId(), "/mobility/driver/location", location);
                sendBroadcast(new Intent(MainActivity.ACTION_LOCATION_STATUS)
                        .setPackage(getPackageName())
                        .putExtra("status", "updated")
                        .putExtra("latitude", location.getLatitude())
                        .putExtra("longitude", location.getLongitude()));
                if (!SessionStore.hasCurrentSession(this, currentToken, currentApi)) return;
                JSONArray trips = getTrips(currentApi, currentToken);
                if (trips != null) {
                    activeTripId = findActiveTripId(trips);
                    if (!appVisible) notifyNewAssignedTrips(trips);
                }
                if (activeTripId != null && SessionStore.hasCurrentSession(this, currentToken, currentApi)) {
                    postLocation(currentApi, currentToken, sessionDeviceId(), "/mobility/driver/trips/" + encodePath(activeTripId) + "/location", location);
                }
            } catch (RequestFailure e) {
                android.util.Log.e(TAG, "POST " + "/mobility/driver/location" + " rechazado: " + e.kind);
                handleRequestFailure(e);
            } catch (Exception error) {
                android.util.Log.e(TAG, "Error enviando ubicación: " + error.getClass().getSimpleName());
            }
        });
    }



    private void pollTripsIfBackground() {
        if (!PermissionGate.operational(this) || !SessionStore.isValid(this)) {
            android.util.Log.w(TAG, "Trip poll detenido: permisos o sesión no operativos");
            stopSelf();
            return;
        }
        if (appVisible || token == null || api == null || !networkAvailable
                || !SessionStore.hasCurrentSession(this, token, api)) {
            android.util.Log.d(TAG, "Trip poll omitido visible=" + appVisible + " network=" + networkAvailable);
            return;
        }
        if (System.currentTimeMillis() < retryNotBefore) return;
        if (!pollRunning.compareAndSet(false, true)) return;
        try {
            final String currentToken = token;
            final String currentApi = api;
            if (!SessionStore.hasCurrentSession(this, currentToken, currentApi)) return;
            JSONArray trips = getTrips(currentApi, currentToken);
            if (trips != null) {
                android.util.Log.i(TAG, "Trip poll OK count=" + trips.length());
                notifyNewAssignedTrips(trips);
                resetRetryBackoff();
            }
        } catch (RequestFailure e) {
            handleRequestFailure(e);
        } catch (Exception e) {
            android.util.Log.e(TAG, "Trip poll error=" + e.getClass().getSimpleName(), e);
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
            android.util.Log.i(TAG, "GET /mobility/driver/trips HTTP " + status);
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

    private String sessionDeviceId() {
        return SessionStore.getDeviceId(this);
    }

    private void postLocation(String currentApi, String currentToken, String deviceId, String path, Location location) throws RequestFailure {
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
            String body = String.format(Locale.US, "{\"latitude\":%.7f,\"longitude\":%.7f,\"accuracy\":%.2f,\"device_id\":\"%s\"}", location.getLatitude(), location.getLongitude(), location.getAccuracy(), deviceId);
            try (OutputStream out = connection.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
            int status = connection.getResponseCode();
            android.util.Log.i(TAG, "POST " + path + " HTTP " + status);
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
            // Open requests are returned as `searching` to every eligible
            // driver; once claimed, the same contract becomes `assigned`.
            // Both states are new-trip offers and must alert in background.
            String status = trip == null ? "" : trip.optString("status");
            if (!"searching".equals(status) && !"assigned".equals(status)) continue;
            String id = trip.optString("id", "");
            android.util.Log.i(TAG, "Trip offer status=" + status + " id_present=" + !id.isEmpty());
            if (id.isEmpty() || !TripNotificationStore.reserve(this, id, now)) {
                android.util.Log.i(TAG, "Trip offer skipped empty_or_reserved=" + id.isEmpty());
                continue;
            }
            try {
                notifyTrip(id, trip);
                TripNotificationStore.markNotified(this, id, System.currentTimeMillis());
            } catch (RuntimeException e) {
                android.util.Log.e(TAG, "Trip notification error=" + e.getClass().getSimpleName(), e);
                // Leave the reservation pending so the normal poll can retry it.
            }
        }
    }

    private boolean tripNotificationsEnabled() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            android.util.Log.e(TAG, "Trip notification disabled: NotificationManager unavailable");
            return false;
        }
        if (Build.VERSION.SDK_INT >= 24 && !manager.areNotificationsEnabled()) {
            android.util.Log.w(TAG, "Trip notification disabled by Android");
            return false;
        }
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = manager.getNotificationChannel(TRIP_CHANNEL);
            boolean enabled = channel != null && channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
            android.util.Log.i(TAG, "Trip channel exists=" + (channel != null)
                    + " importance=" + (channel == null ? -1 : channel.getImportance()) + " enabled=" + enabled);
            return enabled;
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
        android.util.Log.i(TAG, "Trip notification posted channel=" + TRIP_CHANNEL);
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
        if (fused != null) {
            try { fused.removeLocationUpdates(fusedCallback); } catch (RuntimeException ignored) {}
        }
        if (tripPoll != null) tripPoll.cancel(true);
        if (connectivity != null && connectivityCallback != null && Build.VERSION.SDK_INT >= 21) {
            try { connectivity.unregisterNetworkCallback(connectivityCallback); } catch (RuntimeException ignored) {}
        }
        network.shutdownNow();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
