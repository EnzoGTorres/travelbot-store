# Travelbot

Proyecto personal en Node.js + TypeScript para monitorear vuelos y enviar alertas por Telegram.

## Que queda resuelto en esta fase

- Sigue funcionando localmente con `npm run dev`.
- Tiene endpoint serverless seguro en `POST /api/check`.
- Tiene workflow de GitHub Actions listo para ejecutarse manualmente o por `schedule`.
- La persistencia queda separada por proveedor:
  - local: archivo JSON
  - Vercel: store JSON persistido en GitHub Contents API

## Persistencia y Vercel

`data/alerts.json` funciona bien en local, pero no es confiable en Vercel porque el filesystem serverless es efimero entre invocaciones.

Por eso la estrategia minima viable de esta fase es:

- mantener `data/alerts.json` para desarrollo local
- usar el mismo JSON, pero guardado en un archivo del repo via GitHub Contents API cuando `TRAVELBOT_STORE_PROVIDER=github`

Esto evita base de datos, mantiene la arquitectura simple y deja una ruta clara de deploy personal. La contrapartida es que para Vercel necesitas un `GITHUB_STORE_TOKEN` con permiso de `contents` sobre el repo donde guardas el archivo.

## Variables de entorno

Base:

```env
SERPAPI_KEY=tu_api_key
SERPAPI_CURRENCY=USD
SERPAPI_LANGUAGE=en
SERPAPI_MARKET=us
TELEGRAM_BOT_TOKEN=tu_token
TELEGRAM_CHAT_ID=tu_chat_id
TRAVELBOT_CHECK_SECRET=un_secret_largo
TRAVELBOT_DRY_RUN=false
```

Local:

```env
TRAVELBOT_STORE_PROVIDER=file
TRAVELBOT_ALERTS_FILE=data/alerts.json
```

Vercel con store en GitHub:

```env
TRAVELBOT_STORE_PROVIDER=github
GITHUB_STORE_OWNER=tu_usuario_o_org
GITHUB_STORE_REPO=tu_repo
GITHUB_STORE_BRANCH=main
GITHUB_STORE_PATH=data/alerts.json
GITHUB_STORE_TOKEN=github_pat_con_permiso_contents
```

## Uso local

1. Completa tu `.env`.
2. Ajusta `data/alerts.json`.
3. Ejecuta:

```bash
npm run dev
```

Compilar:

```bash
npm run build
```

Modo local dry-run:

```bash
TRAVELBOT_DRY_RUN=true npm run dev
```

En dry-run se consultan vuelos y se evalúan alertas, pero no se envía Telegram y no se persiste estado.

Diagnostico del store GitHub:

```bash
npm run test:store
```

Si prefieres lanzarlo desde la entrada normal:

```powershell
$env:TRAVELBOT_RUN_STORE_DIAGNOSTIC='true'
npm run dev
```

El diagnostico verifica acceso al repo, lectura del archivo, creacion inicial si falta, y un write probe para validar permisos de escritura.

## Endpoint serverless

Ruta:

```text
/api/check
```

Metodos soportados:

- `POST`
- `GET`

Proteccion:

- header recomendado: `x-travelbot-secret: <TRAVELBOT_CHECK_SECRET>`
- fallback simple: `?secret=<TRAVELBOT_CHECK_SECRET>`

Ejemplo con `curl`:

```bash
curl -X POST \
  -H "x-travelbot-secret: tu_secret" \
  https://tu-app.vercel.app/api/check
```

Ejemplo con `curl` en dry-run:

```bash
curl -X POST \
  -H "x-travelbot-secret: tu_secret" \
  "https://tu-app.vercel.app/api/check?dryRun=true"
```

Respuesta esperada:

```json
{
  "ok": true,
  "dryRun": false,
  "storageMode": "github",
  "checkedCount": 3,
  "alertsEligible": 1,
  "alertsSent": 1,
  "skipped": 2,
  "errors": 0,
  "durationMs": 4821,
  "startedAt": "2026-03-27T10:00:00.000Z",
  "finishedAt": "2026-03-27T10:00:04.821Z",
  "store": "github://owner/repo/data/alerts.json@main",
  "persistence": {
    "attempted": true,
    "persisted": true,
    "retried": false
  },
  "details": [
    {
      "searchId": "eze-mad-may-2026",
      "searchName": "Buenos Aires a Madrid en mayo 2026",
      "ok": true,
      "status": "price_down",
      "dryRun": false,
      "alertEligible": true,
      "alertSent": true,
      "notificationStatus": "sent",
      "alertType": "below_threshold",
      "currentPrice": 779,
      "currency": "USD",
      "notificationReason": "Alerta enviada: precio bajo umbral (USD 779).",
      "summary": "[eze-mad-may-2026] status=price_down eligible=yes notification=sent price=USD 779",
      "log": "..."
    }
  ]
}
```

## Deploy en Vercel

1. Sube el repo a GitHub.
2. Importa el proyecto en Vercel.
3. Configura estas env vars en Vercel:
   - `SERPAPI_KEY`
   - `SERPAPI_CURRENCY`
   - `SERPAPI_LANGUAGE`
   - `SERPAPI_MARKET`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `TRAVELBOT_CHECK_SECRET`
   - `TRAVELBOT_STORE_PROVIDER=github`
   - `GITHUB_STORE_OWNER`
   - `GITHUB_STORE_REPO`
   - `GITHUB_STORE_BRANCH`
   - `GITHUB_STORE_PATH`
   - `GITHUB_STORE_TOKEN`
4. Asegurate de que el token tenga permiso para leer y escribir contenidos del repo.
5. Deploya.
6. Prueba el endpoint:

```bash
curl -X POST \
  -H "x-travelbot-secret: tu_secret" \
  https://tu-app.vercel.app/api/check
```

Si quieres probar sin enviar alertas ni persistir estado:

```bash
curl -X POST \
  -H "x-travelbot-secret: tu_secret" \
  "https://tu-app.vercel.app/api/check?dryRun=true"
```

## Workflow de GitHub Actions

Archivo generado:

- `.github/workflows/travelbot-check.yml`

Incluye:

- `workflow_dispatch`
- `schedule`
- input manual `dry_run`
- llamada simple con `curl`

Secrets requeridos en GitHub:

- `TRAVELBOT_CHECK_URL`
  ejemplo: `https://tu-app.vercel.app/api/check`
- `TRAVELBOT_CHECK_SECRET`
  debe coincidir con `TRAVELBOT_CHECK_SECRET` configurado en Vercel

Cron actual de ejemplo:

```text
0 */6 * * *
```

Eso ejecuta el chequeo cada 6 horas. Puedes ajustarlo despues segun tu uso personal.

## Archivos principales de esta fase

- `src/store.ts`: persistencia dual `file` / `github`
- `src/runtime.ts`: runner reutilizable con resumen estructurado
- `src/index.ts`: entrada local
- `api/check.ts`: endpoint serverless
- `vercel.json`: configuracion minima para Vercel
- `.github/workflows/travelbot-check.yml`: scheduler externo

## Notas de diseno

- No se agrego base de datos.
- No se agrego UI.
- No se agregaron comandos nuevos de Telegram.
- No se cambio SerpAPI salvo lo necesario para reutilizar el runner.
- El store GitHub es una solucion minima viable para seguir avanzando. Si mas adelante necesitas mas robustez o concurrencia fuerte, ahi si convendra migrar a un storage dedicado.

## Troubleshooting basico

- Si una corrida da `dryRun=true`, no se envia Telegram y no se persiste estado por diseño.
- Si GitHub devuelve conflicto al escribir, Travelbot relee el sha actual, reintenta una vez y deja el evento visible en logs.
- Si falla la persistencia final, la corrida devuelve error explicito con resumen parcial para que se vea que las consultas corrieron pero el store no quedo guardado.
- Si una busqueda individual falla, las otras siguen ejecutandose y el error queda reflejado en `details`.
