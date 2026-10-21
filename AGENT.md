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

Railway es la única plataforma de despliegue activa para todos los servicios y frontends de Livre. Vercel ya no forma parte del stack: no consultar sus aliases históricos, no publicar allí y no usar su estado como referencia de disponibilidad, salvo pedido explícito del usuario. Confirmar siempre el estado real del servicio en Railway.

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

## Regla comercial de tarifa visible (2026-10-20)

- `service_type_id = "2"` identifica Livre Ahorro: la tarjeta debe mostrar el importe bruto del conductor y `0% comisión`.
- Para otros servicios, mostrar 85% al conductor y 15% de comisión según el snapshot comercial vigente; no volver a descontar un `final_fare` ya neto.
- El frontend debe priorizar `service_type_id` frente a `discount_percentage` o snapshots antiguos. Un snapshot obsoleto no puede forzar la etiqueta `15% comisión` en Ahorro.
- El contrato esperado con Cloud usa `service_type_id`, `driver_fare` y `commission_percentage`; cualquier cambio debe validar importe y etiqueta, no sólo que el bundle compile.
- La regresión de la tarjeta debe reproducir un snapshot Ahorro obsoleto (bruto `5054.00`, neto histórico `4295.90`) y comprobar que muestra el bruto y `0% comisión`.
- Antes de declarar resuelto un bug visual, verificar por HTTPS el asset publicado y, si hay credenciales legítimas, la respuesta autenticada de API. No inventar viajes ni credenciales.
- Corrección coordinada publicada con Cloud: commit `23b434b` en este repositorio y `4b4b34f` en `livre-cloud`.

## Temas visuales y paleta Livre (2026-10-20)

- La identidad visual usa rojo Livre `#e8003d` para marca, títulos, acciones de configuración, historial y cierre.
- El verde queda reservado para estados operativos, como conductor disponible o GPS activo; no usarlo como color general de Configuración.
- Light debe usar fondo global claro, superficies blancas, bordes grises y texto oscuro. Dark debe usar fondo `#07080a`, superficies `#181a20`, bordes `#24262d` y texto claro.
- Configuración e Historial de cierre deben compartir superficie propia, borde, overlay y contraste con el tema activo; no usar fondos hardcodeados que sobrevivan al cambio de tema.
- Validar siempre ambos modos en navegador, incluyendo topbar, menú operativo, modal de configuración, historial, inputs, avisos y botones.
- Las preferencias inválidas de `localStorage` deben volver a valores seguros; no permitir que un valor desconocido deje la interfaz en un tema inconsistente.
- Validación local obligatoria para cambios visuales: `node --test tests/*.test.js`, `node --check js/app.js` y `git diff --check`.
- Confirmar el asset publicado por HTTPS después del push y verificar el deploy en Railway. No informar disponibilidad de una corrección sólo por haber hecho commit.

## Tarjeta residual por ofertas globales (2026-10-20)

- La tarjeta incompleta que reaparecía sobre el panel no era un problema de caché: el frontend estaba tratando viajes `searching` como si fueran viajes activos del conductor.
- `searching` representa una oferta global y no debe convertirse en la tarjeta principal de este conductor.
- La tarjeta principal solo puede seleccionar viajes en estados `assigned`, `arriving` o `in_progress`; si no existe uno de esos estados, `selected` debe quedar en `null` y mostrarse únicamente el panel operativo.
- La protección está centralizada en `DRIVER_CARD_STATUSES` y se aplica tanto al seleccionar como al renderizar la tarjeta.
- La corrección está publicada en producción: commit `d3a0c73` (`No mostrar ofertas globales como viaje activo`), deploy Railway `SUCCESS`.
- Validación realizada: `node --test tests/status.test.js`, `git diff --check` y verificación HTTPS del `js/app.js` publicado.
- No generar viajes reales ni APK para validar esta corrección; debe verificarse primero mediante el flujo web HTTPS y datos de prueba controlados.

## Actualización periódica de ubicación GPS (2026-10-20)

- `watchPosition()` no garantiza callbacks cuando el conductor permanece quieto; tener GPS activo y sesión online no alcanza para mantener una posición vigente en el CRM.
- El frontend web debe enviar la posición actual por HTTP cada 30 segundos mientras el GPS está activo, además de mantener `watchPosition()` para movimientos.
- El heartbeat debe usar `getCurrentPosition()` con `maximumAge: 0`, respetar la sesión/token y detenerse al apagar el GPS para evitar envíos de sesiones viejas.
- La corrección vive en `js/app.js`, commit `6ff2ecc`, y fue verificada en producción por HTTPS después del deploy Railway.
- Validación ejecutada: `node --test tests/status.test.js` → 30 pasaron, 0 fallaron; `git diff --check` → OK. `npm test` no aplica porque el repositorio no tiene `package.json`.

## Trazado rígido y aviso visual de desvíos (2026-10-21)

- La ruta planificada debe seguir la geometría vial recibida y dibujarse con `smoothFactor: 0.1`; no suavizarla con valores altos que oculten curvas o desvíos.
- El GPS real del conductor se compara contra la ruta planificada usando una distancia aproximada en metros y la precisión reportada por el navegador.
- El trazo real usa colores semánticos: celeste dentro de ruta, amarillo ante separación moderada y rojo ante desvío confirmado.
- No marcar rojo por una sola posición: exigir varios puntos consecutivos fuera de tolerancia para evitar falsos avisos por ruido GPS.
- El estado visible debe permanecer en el panel de guía y el color rojo debe representar el recorrido real desviado, no pintar como incorrecta la ruta planificada.
- La lógica vive en `js/app.js`; los estados visuales viven en `css/styles.css`. El cache-busting de ambos assets se mantiene en `index.html`.
- Corrección publicada en `livre-conductor`: commit `d359275`; actualización de assets: commit `0017739`.
- Validar con `node --check js/app.js` y `git diff --check`; no usar `npm test` porque el repositorio no tiene `package.json`. Verificar además el asset publicado por HTTPS y el deploy Railway antes de afirmar disponibilidad.
