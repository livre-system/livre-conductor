package com.livre.conductor;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.net.Uri;
import android.app.AlertDialog;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private WebView webView;
    private static final int LOCATION_REQUEST = 41;
    private static final int BACKGROUND_LOCATION_REQUEST = 42;
    private boolean backgroundSettingsOpened;
    private String pendingToken;
    private String pendingApi;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setDatabaseEnabled(true);
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, true, false);
            }
        });
        webView.addJavascriptInterface(new AndroidGpsBridge(), "AndroidGps");
        webView.loadUrl("https://livre-conductor-production.up.railway.app/");
        setContentView(webView);
    }

    private void requestLocationAndStart() {
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED && checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, LOCATION_REQUEST);
            return;
        }
        requestBackgroundLocationOrStart();
    }

    private void requestBackgroundLocationOrStart() {
        if (Build.VERSION.SDK_INT < 29 || checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            startLocationService();
            return;
        }
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
                        startLocationService();
                    })
                    .setNegativeButton("Ahora no", (dialog, which) -> startLocationService())
                    .show();
        } else {
            startLocationService();
        }
    }

    private void startLocationService() {
        Intent intent = new Intent(this, LocationService.class);
        intent.putExtra("token", pendingToken);
        intent.putExtra("api", pendingApi);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent); else startService(intent);
    }

    @Override protected void onResume() {
        super.onResume();
        if (pendingToken != null && backgroundSettingsOpened && Build.VERSION.SDK_INT >= 29 && checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            startLocationService();
        }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == LOCATION_REQUEST && pendingToken != null) requestLocationAndStart();
        if (request == BACKGROUND_LOCATION_REQUEST && pendingToken != null) startLocationService();
    }

    @Override public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }

    public class AndroidGpsBridge {
        @JavascriptInterface public void startLocation(String token, String api) {
            pendingToken = token;
            pendingApi = api;
            getSharedPreferences("livre", MODE_PRIVATE).edit().putString("token", token).putString("api", api).apply();
            runOnUiThread(() -> requestLocationAndStart());
        }
        @JavascriptInterface public void stopLocation() {
            stopService(new Intent(MainActivity.this, LocationService.class));
        }
    }
}
