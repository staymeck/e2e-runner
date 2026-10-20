# e2e-runner

Formosre E2E Runner Service: encola, ejecuta y supervisa corridas E2E (Detox primero, Cucumber después) detrás de una API.
Diseño: [docs/design.md](docs/design.md).

## Requisitos

Node >= 22.13.

## Comandos

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev      # tsx, sin compilar
npm start        # dist/main.js, tras npm run build
```

## Configuración

Todo por variables de entorno más un archivo JSON de proyectos. El servicio **no arranca** si algo falta o es inválido y
lista todos los problemas a la vez.

| Variable | Obligatoria | Descripción |
|---|---|---|
| `E2E_SERVICE_API_KEY` | sí | Clave de la API (16 caracteres o más). No hay modo abierto |
| `E2E_SERVICE_API_KEY_NEXT` | no | Segunda clave aceptada mientras se rota la primera |
| `E2E_SERVICE_DATA_DIR` | sí | Ruta absoluta: base SQLite, logs y reportes |
| `E2E_SERVICE_CONFIG` | sí | Ruta del JSON de proyectos |
| `E2E_SERVICE_HOST` / `E2E_SERVICE_PORT` | no | Por defecto `127.0.0.1:8090` |
| `E2E_SERVICE_LOG_LEVEL` | no | Nivel de pino (`info`) |
| `E2E_DETOX_RUNNER_DIR` | con un proyecto `detox` | Carpeta donde corren los jobs |
| `E2E_DETOX_INFO_DIR` | con un proyecto `detox` | Carpeta para consultar ramas y escenarios |

Las dos carpetas de Detox deben existir, ser rutas absolutas y **distintas** (no la misma, ni enlaces a la misma, ni una
dentro de la otra).

Ejemplo de `E2E_SERVICE_CONFIG`:

```json
{
  "projects": {
    "detox": {
      "adapter": "detox",
      "repo": "git@git.example.com:formos/detox-testing.git",
      "allowedBranches": ["iteration_*", "main"],
      "defaultBranch": "iteration_1"
    }
  }
}
```

## API

Toda petición necesita `Authorization: Bearer <clave>`.

- `GET /v1/health`: `{ "ok": true }`.

## Convenciones

- La inyección de dependencias usa `@Inject(TOKEN)` explícito en cada constructor: las pruebas corren con `tsx`, que no
  emite metadatos de tipos.
- `src/core` no importa de `adapters`; los adaptadores dependen del núcleo.
