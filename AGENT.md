## REGLA PRIORITARIA: HTTP PRIMERO, APK SOLO CUANDO SEA INEVITABLE

- Antes de modificar código, determinar qué solución puede implementarse por HTTP desde el servidor web y cuál requiere cambios nativos en Android.
- Priorizar siempre los cambios remotos para evitar reinstalar o distribuir APK nuevas en decenas de dispositivos.
- El objetivo estratégico es llegar a una única versión estable y actualizada de la APK, y resolver a partir de ella la mayor cantidad posible de funcionalidades, correcciones y mejoras mediante el servidor web.
- Generar una APK nueva únicamente cuando exista una limitación técnica real que impida resolver el problema remotamente.
- Cuando haya cambios mixtos, separar explícitamente los que pueden desplegarse por HTTP de los que requieren APK, y minimizar estos últimos.
- Antes de proponer una APK nueva, justificar por qué no alcanza con modificar el frontend, el backend o la configuración remota.
- No modificar, reemplazar ni distribuir APK sin autorización explícita.
- Esta regla aplica a todas las tareas futuras, diagnósticos, correcciones y funcionalidades de Livre.
