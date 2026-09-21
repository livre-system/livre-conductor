# Livre Conductor

Primera versión web móvil de la app del conductor.

## Ejecutar localmente

```bash
python3 -m http.server 4174
```

Abrir `http://localhost:4174`.

La API se puede cambiar con `?api=https://...`.

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
