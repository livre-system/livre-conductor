# Livre Conductor Android

La app Android conserva la interfaz web y agrega un servicio foreground nativo para enviar la ubicación cada 10–15 segundos, incluso con pantalla bloqueada o la app en segundo plano.

## Permisos

Al abrir la app se solicitan ubicación precisa, ubicación en segundo plano y notificaciones. Android muestra una notificación permanente mientras la ubicación está activa.

## Compilar APK de prueba

El workflow `.github/workflows/android-apk.yml` genera `app-debug.apk` como artifact en cada push que modifica la app o el proyecto Android.

La APK necesita que el conductor no fuerce “Detener” desde Ajustes y que quite las restricciones de batería para Livre en los teléfonos que la aplican.
