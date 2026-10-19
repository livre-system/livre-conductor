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

## BACKUP INTEGRAL DE LIVRE — 19/10/2026

- Fecha y hora del backup: 19/10/2026 04:40:50 ART (07:40:50 UTC). La publicación de los repositorios privados terminó a las 04:42:11 ART.
- Backup local completo de los cuatro repositorios, incluyendo `.git`, archivos trackeados, ignorados y no trackeados: `/home/calambre/Backups/Livre/20261019_044050`.
- El backup local contiene cuatro archivos `.tar.zst`, con manifiesto y `SHA256SUMS`; los cuatro checksums coincidieron y los cuatro archivos pudieron listarse correctamente.
- Copias privadas en GitHub, sin sobrescribir los repositorios originales:
  - `livre-cloud`: https://github.com/livre-system/livre-cloud-backup-20261019
  - `livre-chatbot`: https://github.com/livre-system/livre-chatbot-backup-20261019
  - `livre-pasajeros`: https://github.com/livre-system/livre-pasajeros-backup-20261019
  - `livre-conductor`: https://github.com/livre-system/livre-conductor-backup-20261019
- Las copias remotas preservan el historial Git y las ramas existentes. En `livre-cloud` también se publicó la rama `backup-20261019_044211` con los cambios locales detectados; su commit verificado es `e66e9b4fc4e77eeab46c8e378b17d6c08817cef3`.
- `.env.local` de `livre-chatbot` y `credenciales-renombradas-187.md` de `livre-conductor` fueron excluidos de GitHub por seguridad. Quedaron incluidos únicamente en el backup local protegido.
- Verificación remota: los cuatro repositorios figuran como privados y se confirmaron sus ramas e historiales mediante GitHub.
- Este backup no ejecutó deploys, no modificó producción, no creó viajes y no alteró APKs.

## Consistencia del canal de notificaciones (2026-10-19)

- El canal activo de viajes es `livre_trips_v2`.
- `PermissionGate.java`, `MainActivity.java` y `LocationService.java` deben crear o consultar exactamente `livre_trips_v2`; no reintroducir `livre_trips`.
- Se agregó una regresión estática que compara las referencias de esos tres componentes.
- Validación local: `node --test tests/*.test.js` → `33 passed, 0 failed`; `node --check js/app.js` → OK; `git diff --check` → OK.
- No se construyó ni distribuyó APK. La verificación en dispositivo/emulador y la disponibilidad real del canal quedan pendientes.
