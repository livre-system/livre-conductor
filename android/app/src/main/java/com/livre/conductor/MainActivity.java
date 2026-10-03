package com.livre.conductor;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;

public class MainActivity extends Activity {
    public static final String ACTION_SESSION_INVALIDATED = "com.livre.conductor.SESSION_INVALIDATED";
    private static final String WEB_URL = "https://livre-conductor-production.up.railway.app/";
    private static final int LOCATION_REQUEST = 41;
    private static final int BACKGROUND_LOCATION_REQUEST = 42;
    private static final int NOTIFICATION_REQUEST = 43;
    private WebView webView;
    private boolean backgroundSettingsOpened;
    private boolean notificationWarningShown;
    private boolean permissionDialogShown;
    private boolean serviceOperational;
    private boolean notificationPermissionRequestInFlight;
    private String pendingToken;
    private String pendingTripId;

    private enum PermissionState {
        SESSION_INVALID,
        PRECISE_LOCATION_MISSING,
        BACKGROUND_LOCATION_MISSING,
        NOTIFICATIONS_MISSING,
        GPS_DISABLED,
        READY
    }
    private PermissionGate.State lastPermissionState;
    private final BroadcastReceiver sessionReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            clearSession();
            if (webView != null) webView.evaluateJavascript("window.onNativeSessionExpired && window.onNativeSessionExpired()", null);
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        webView.setWebViewClient(new ResilientWebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                boolean trustedOrigin = "https://livre-conductor-production.up.railway.app".equals(origin);
                callback.invoke(origin, trustedOrigin && PermissionGate.operational(MainActivity.this), false);
            }
        });
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidGps");
        setContentView(webView);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(sessionReceiver, new IntentFilter(ACTION_SESSION_INVALIDATED), Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(sessionReceiver, new IntentFilter(ACTION_SESSION_INVALIDATED));
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermissionRequestInFlight = true;
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
        }
        handleIntent(getIntent());
        webView.loadUrl(WEB_URL);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String tripId = intent.getStringExtra("trip_id");
        if (tripId != null && !tripId.isEmpty()) {
            pendingTripId = tripId;
            deliverPendingTrip();
        }
    }

    private void deliverPendingTrip() {
        if (webView == null || pendingTripId == null) return;
        final String trip = pendingTripId;
        webView.postDelayed(() -> webView.evaluateJavascript(
                "window.onNativeTripNotification && window.onNativeTripNotification(" + JSONObject.quote(trip) + ")",
                value -> { if ("true".equals(value)) pendingTripId = null; }), 350);
    }

    private boolean areTripNotificationsEnabled() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT >= 24 && !manager.areNotificationsEnabled()) return false;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = manager.getNotificationChannel("livre_trips");
            return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
        }
        return true;
    }

    private void requestLocationAndStart() {
        PermissionGate.State state = PermissionGate.evaluate(this);
        if (state == PermissionGate.State.NEED_PRECISE_LOCATION) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_REQUEST);
            return;
        }
        if (state == PermissionGate.State.NEED_BACKGROUND_LOCATION) {
            requestBackgroundLocation();
            return;
        }
        if (state == PermissionGate.State.NEED_NOTIFICATIONS) {
            if (Build.VERSION.SDK_INT >= 33) {
                notificationPermissionRequestInFlight = true;
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
            } else {
                warnIfTripNotificationsDisabled();
            }
            return;
        }
        if (state == PermissionGate.State.LOCATION_DISABLED) {
            showLocationDisabledWarning();
            return;
        }
        startLocationService();
    }

    private void requestBackgroundLocation() {
        if (Build.VERSION.SDK_INT == 29) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION}, BACKGROUND_LOCATION_REQUEST);
            return;
        }
        if (!backgroundSettingsOpened) {
            backgroundSettingsOpened = true;
            new AlertDialog.Builder(this)
                    .setTitle("Ubicación siempre activa")
                    .setMessage("Para compartir tu ubicación aunque la app quede en segundo plano, abrí Permisos, elegí Ubicación y seleccioná ‘Permitir todo el tiempo’.")
                    .setPositiveButton("Abrir permisos", (dialog, which) -> {
                        Intent settings = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
                        startActivity(settings);
                    })
                    .setNegativeButton("Ahora no", null)
                    .show();
        }
    }

    private void startLocationService() {
        SessionStore.Session session = SessionStore.read(this);
        if (session == null || PermissionGate.evaluate(this) != PermissionGate.State.READY) {
            stopService(new Intent(this, LocationService.class));
            publishPermissionState();
            return;
        }
        Intent intent = new Intent(this, LocationService.class);
        intent.putExtra("token", session.token);
        intent.putExtra("api", session.api);
        intent.putExtra("app_visible", true);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent); else startService(intent);
        serviceOperational = true;
        webView.postDelayed(this::warnIfTripNotificationsDisabled, 300);
    }

    private void setServiceAppVisible(boolean visible) {
        if (!SessionStore.isValid(this) || PermissionGate.evaluate(this) != PermissionGate.State.READY) {
            stopService(new Intent(this, LocationService.class));
            publishPermissionState();
            return;
        }
        Intent intent = new Intent(this, LocationService.class);
        intent.putExtra("app_visible", visible);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent); else startService(intent);
    }

    @Override protected void onResume() {
        super.onResume();
        warnIfTripNotificationsDisabled();
        reviewPermissionState();
        deliverPendingTrip();
    }

    @Override protected void onPause() {
        if (pendingToken != null) setServiceAppVisible(false);
        super.onPause();
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == NOTIFICATION_REQUEST) notificationPermissionRequestInFlight = false;
        if (request == NOTIFICATION_REQUEST) warnIfTripNotificationsDisabled();
        if ((request == LOCATION_REQUEST || request == BACKGROUND_LOCATION_REQUEST || request == NOTIFICATION_REQUEST) && pendingToken != null) requestLocationAndStart();
        publishPermissionState();
    }

    @Override public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }

    private void clearSession() {
        pendingToken = null;
        pendingTripId = null;
        serviceOperational = false;
        stopService(new Intent(MainActivity.this, LocationService.class));
        SessionStore.clear(this);
    }

    private void warnIfTripNotificationsDisabled() {
        if (notificationPermissionRequestInFlight || notificationWarningShown || areTripNotificationsEnabled()) return;
        notificationWarningShown = true;
        new AlertDialog.Builder(this)
                .setTitle("Notificaciones desactivadas")
                .setMessage("Activá las notificaciones de Livre para recibir nuevos viajes mientras la app está en segundo plano.")
                .setPositiveButton("Abrir ajustes", (dialog, which) -> {
                    Intent settings = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                    startActivity(settings);
                })
                .setNegativeButton("Ahora no", null)
                .show();
    }

    private void reviewPermissionState() {
        PermissionGate.State state = PermissionGate.evaluate(this);
        boolean changed = state != lastPermissionState;
        lastPermissionState = state;
        publishPermissionState();
        if (state != PermissionGate.State.READY) {
            stopService(new Intent(this, LocationService.class));
            if (pendingToken != null && changed) showPermissionState(state);
            return;
        }
        backgroundSettingsOpened = false;
        if (pendingToken != null) startLocationService();
    }

    private void publishPermissionState() {
        if (webView == null) return;
        String state = PermissionGate.evaluate(this).name();
        webView.evaluateJavascript(
                "window.onNativePermissionState && window.onNativePermissionState(" + JSONObject.quote(state) + ")",
                null);
    }

    private void showPermissionState(PermissionGate.State state) {
        if (state == PermissionGate.State.NEED_NOTIFICATIONS) {
            warnIfTripNotificationsDisabled();
            return;
        }
        if (state == PermissionGate.State.NEED_BACKGROUND_LOCATION) {
            new AlertDialog.Builder(this)
                    .setTitle("Ubicación en segundo plano deshabilitada")
                    .setMessage("Livre necesita ‘Permitir todo el tiempo’ para compartir GPS y recibir viajes con la app cerrada.")
                    .setPositiveButton("Abrir permisos", (dialog, which) -> requestBackgroundLocation())
                    .setNegativeButton("Ahora no", null)
                    .show();
            return;
        }
        if (state == PermissionGate.State.NEED_PRECISE_LOCATION) {
            new AlertDialog.Builder(this)
                    .setTitle("Ubicación precisa deshabilitada")
                    .setMessage("Livre necesita ubicación precisa para compartir correctamente la posición del conductor.")
                    .setPositiveButton("Conceder permiso", (dialog, which) -> requestLocationAndStart())
                    .setNegativeButton("Ahora no", null)
                    .show();
            return;
        }
        showLocationDisabledWarning();
    }

    private void showLocationDisabledWarning() {
        new AlertDialog.Builder(this)
                .setTitle("GPS deshabilitado")
                .setMessage("Activá la ubicación del dispositivo para que Livre pueda compartir tu posición.")
                .setPositiveButton("Abrir ajustes", (dialog, which) -> startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)))
                .setNegativeButton("Ahora no", null)
                .show();
    }

    public class AndroidBridge {
        @JavascriptInterface public void startLocation(String token, String api) {
            if (!SessionStore.save(MainActivity.this, token, api)) return;
            pendingToken = token;
            runOnUiThread(() -> requestLocationAndStart());
        }
        @JavascriptInterface public void stopLocation() {
            serviceOperational = false;
            stopService(new Intent(MainActivity.this, LocationService.class));
        }
        @JavascriptInterface public void clearSession() { runOnUiThread(() -> clearSession()); }
        @JavascriptInterface public void setAppVisible(boolean visible) {
            runOnUiThread(() -> setServiceAppVisible(visible));
        }
        @JavascriptInterface public boolean areTripNotificationsEnabled() { return MainActivity.this.areTripNotificationsEnabled(); }
        @JavascriptInterface public String getNativePermissionState() { return PermissionGate.evaluate(MainActivity.this).name(); }
        @JavascriptInterface public boolean consumeSessionInvalidation() { return SessionStore.consumeInvalidation(MainActivity.this); }
        @JavascriptInterface public void confirmTripOpened(String tripId) {
            runOnUiThread(() -> { if (tripId != null && tripId.equals(pendingTripId)) pendingTripId = null; });
        }
        @JavascriptInterface public void confirmTripUnavailable(String tripId) {
            runOnUiThread(() -> { if (tripId != null && tripId.equals(pendingTripId)) pendingTripId = null; });
        }
        @JavascriptInterface public void retryWebView() { runOnUiThread(() -> webView.loadUrl(WEB_URL)); }
    }

    private class ResilientWebViewClient extends WebViewClient {
        @Override public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            deliverPendingTrip();
        }
        @Override public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
            if (request.isForMainFrame()) showWebError();
        }
        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse errorResponse) {
            if (request.isForMainFrame() && errorResponse.getStatusCode() >= 500) showWebError();
        }
    }

    private void showWebError() {
        String html = "<html><body style='background:#07080a;color:white;font-family:sans-serif;padding:32px'><h2>Livre no está disponible</h2><p>Revisá la conexión e intentá nuevamente.</p><button onclick=\"AndroidGps.retryWebView()\">Reintentar</button></body></html>";
        webView.loadDataWithBaseURL(WEB_URL, html, "text/html", "UTF-8", WEB_URL);
    }

    @Override protected void onDestroy() {
        try { unregisterReceiver(sessionReceiver); } catch (IllegalArgumentException ignored) {}
        super.onDestroy();
    }
}
