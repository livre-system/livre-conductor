# Livre Conductor

Panel web móvil del conductor: login, viajes asignados, estados, mapa y GPS obligatorio durante el viaje.

## Ejecutar localmente

```bash
python3 -m http.server 4174
```

Abrir `http://localhost:4174`.

La API se puede cambiar con `?api=https://...`.

## Flujo de prueba

1. Pedir un viaje desde `livre-pasajeros`.
2. Asignar ese viaje a un conductor desde el CRM, usando el `magiis_driver_id` real asociado a la cuenta.
3. Ingresar en esta app con la cuenta Livre del conductor.
4. Seleccionar el viaje: la app solicita permiso de GPS y comienza a enviar ubicación.
5. Avanzar `Voy en camino`, `Iniciar viaje` y `Finalizar viaje`.

## Contrato usado

- `POST /auth/login`
- `GET /mobility/driver/trips`
- `POST /mobility/driver/trips/{id}/status`
- `POST /mobility/driver/trips/{id}/location`

El backend vincula el usuario de Livre con `magiis_driver_id` mediante
`livre_driver_accounts`. La app nunca llama directamente a MAGIIS.

La ubicación enviada por el conductor queda en Livre Cloud y el pasajero la
recibe mediante `GET /mobility/tracking/{tracking_token}`.

## Pendiente de despliegue

Aplicar en PostgreSQL la migración de Livre Cloud:

`app/migrations/20260921_create_driver_accounts.sql`

Después hay que crear la cuenta Livre del conductor y asociarla al ID operativo
del conductor. Sin esa asociación, el login puede funcionar pero la app no
mostrará viajes.
