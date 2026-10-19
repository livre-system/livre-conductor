# AGENT.md — Livre Conductor

## REGLA PRIORITARIA: WEB HTTPS PRIMERO, APK SOLO CUANDO SEA INEVITABLE

- El orden obligatorio de trabajo es: primero verificar y corregir el flujo web por HTTPS en producción; después evaluar la APK.
- Antes de modificar código, determinar qué solución puede implementarse en el frontend web, backend o configuración remota, y cuál requiere cambios nativos en Android.
- Validar primero en un navegador web normal, usando la URL HTTPS de producción, sin APK ni WebView.
- En el flujo web del conductor, comprobar polling, respuestas HTTP y actualización del DOM en primer plano, sin F5, minimización ni reapertura.
- Solo después de que el flujo web funcione automáticamente, investigar la APK y el GPS nativo.
- Priorizar siempre los cambios remotos para evitar reinstalar o distribuir APK nuevas en decenas de dispositivos.
- Generar una APK nueva únicamente cuando exista una limitación técnica real que impida resolver el problema remotamente.
- Antes de proponer una APK nueva, justificar por qué no alcanza con modificar el frontend, el backend o la configuración remota.
- No generar viajes de prueba ni APK por cuenta propia. No modificar, reemplazar ni distribuir APK sin autorización explícita.
- Esta regla aplica a todas las tareas futuras, diagnósticos, correcciones y funcionalidades de Livre.

## LINKS DE PRODUCCIÓN

- **Livre Conductor — web principal:** https://livre-conductor-production.up.railway.app/
  Login y panel web del conductor: viajes asignados, estados y ubicación.
- **Livre Chat:** https://livre-chatbot-production.up.railway.app/
  Chat/IA y CRM para pedir viajes y operar conversaciones.
- **Livre Pasajeros:** https://livre-pasajeros-production.up.railway.app/
  Solicitud y seguimiento de viajes como pasajero.
- **Livre Cloud:** https://livre-cloud-production.up.railway.app/
  Backend/API central de Livre; no es una pantalla web, sus endpoints son consumidos por los demás módulos.

Aliases históricos o alternativos no deben tomarse como URLs principales sin verificación:
- https://livre-chatbot.vercel.app/
- https://livre-pasajeros.vercel.app/
- https://livre-system.github.io/

## COMPORTAMIENTO DE LA COLA DE VIAJES

- La web ordena las solicitudes por `created_at` descendente; usa `id` numérico solo como respaldo.
- La solicitud pendiente más reciente se muestra en la tarjeta principal “¿Aceptás este viaje?”.
- Las solicitudes pendientes anteriores permanecen en “Otros pedidos recibidos” y siguen disponibles para aceptar o rechazar.
- Aceptar o rechazar debe afectar exclusivamente a la solicitud seleccionada.
- Un viaje `arriving` o `in_progress` no debe ser reemplazado visualmente por una solicitud pendiente nueva.
- El polling no puede depender del orden accidental de la respuesta HTTP para seleccionar el viaje principal.
- No modificar la lógica de notificaciones y sonido salvo que una corrección de selección o cola lo requiera.

## VALIDACIÓN Y DESPLIEGUE

- Para cambios de selección o cola, ejecutar `node --test tests/*.test.js`, `node --check js/app.js` y `git diff --check`.
- Verificar por HTTPS que el JavaScript publicado contiene la lógica nueva antes de informar que el cambio está disponible.
- Investigar diferencias entre navegadores, incluido Brave, por separado; no atribuirles la causa sin evidencia.
- No crear viajes reales de prueba, no modificar la APK y no tocar otros repositorios para corregir este flujo web.

## AUDIO DE NUEVOS VIAJES

- Los viajes nuevos llegan por polling; su callback no es una interacción directa del usuario. Safari móvil, Brave y otros navegadores pueden rechazar `HTMLAudioElement.play()` por las políticas de autoplay.
- No asumir que la existencia del archivo alcanza: registrar y distinguir fallos de creación, desbloqueo y reproducción (`alert_audio_create_failed`, `alert_audio_unlock_failed`, `alert_audio_play_failed`).
- Usar MP3 como fuente principal y Ogg/Vorbis como fallback. Seleccionar con `canPlayType()` porque el soporte de Ogg/Vorbis varía entre versiones y navegadores.
- Intentar desbloquear el audio durante la primera interacción real (`pointerdown`, `touchstart` o `keydown`) y también al cambiar el tono desde configuración.
- Mantener un fallback visible cuando el usuario nunca interactuó o el navegador continúa bloqueando el audio. No afirmar que el sonido automático puede garantizarse sin interacción.
- La corrección actual vive en `js/app.js` y usa `assets/audio/car-horn.mp3`, `bus-horn.mp3` y `truck-horn.mp3`, conservando los `.ogg` existentes como fallback.
- Validación automatizada obligatoria: `node --test tests/*.test.js`, `node --check js/app.js` y `git diff --check`.
- La validación real del sonido debe hacerse por separado en Safari móvil y Brave: tocar la pantalla antes de recibir un viaje, confirmar el desbloqueo y luego verificar un viaje nuevo. Chromium no sustituye la prueba de Safari.
