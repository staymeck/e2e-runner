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
| `E2E_SERVICE_CONFIG` | sí | Ruta absoluta del JSON de proyectos |
| `E2E_SERVICE_HOST` / `E2E_SERVICE_PORT` | no | Por defecto `127.0.0.1:8090` |
| `E2E_SERVICE_LOG_LEVEL` | no | Nivel de pino (`info`) |
| `E2E_DETOX_RUNNER_DIR` | con un proyecto `detox` | Carpeta donde corren los jobs |
| `E2E_DETOX_INFO_DIR` | con un proyecto `detox` | Carpeta para consultar ramas y escenarios |
| `E2E_WEB_USERS` | no | Usuarios fijos de la web: `usuario:password:rol,...` (roles: `e2e-mobile`, `e2e-cypress`, `admin`). Vacío = nadie puede loguearse en la web |
| `E2E_WEBHOOK_SUBSCRIBERS` | no | Suscriptores de webhooks firmados: `host:secret[:secretAnterior],...`. Vacío = webhooks deshabilitados |

Ver [`.env.example`](.env.example) para una plantilla lista para copiar (no se carga sola — `e2e-runner` lee `process.env`
directo, sin `dotenv`; hay que cargarla a mano, por ejemplo `set -a; source .env; set +a`).

Las dos carpetas de Detox deben existir, ser rutas absolutas y **distintas** (no la misma, ni enlaces a la misma, ni una
dentro de la otra). `E2E_SERVICE_DATA_DIR` tampoco puede estar dentro de ninguna de las dos, ni contenerlas: un `checkout`
o un `git clean` borraría la base de datos.

### Crear las dos carpetas de Detox

El servicio **no** las crea: quien despliega las prepara una vez, como dos *worktrees* del mismo clon, para que un
`fetch` sirva a las dos y los commits fijados sean visibles en ambas:

```bash
git clone git@git.example.com:formos/detox-testing.git e2e-detox-runner
git -C e2e-detox-runner worktree add --detach ../e2e-detox-info origin/iteration_1
```

Con un par de `git clone` separados el servicio se niega a arrancar. La llave SSH de despliegue debe ser de solo
lectura; el servicio nunca hace `push`. Git no pregunta nunca por contraseñas (`GIT_TERMINAL_PROMPT=0`, ssh en modo
`BatchMode`) salvo que la variable genérica de git `GIT_SSH_COMMAND` ya esté puesta en el entorno, en cuyo caso se
respeta tal cual.

En el JSON, `repo` acepta `ssh://`, `https://`, `file://` o `usuario@host:ruta`; las ramas y patrones se validan como
nombres de rama de git, y una clave desconocida en un proyecto se rechaza.

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
- `GET /v1/projects`: proyectos configurados, con su rama por defecto y las ramas permitidas.
- `POST /v1/jobs` `{ "project", "target", "ref"?, "kind"?, "params"? }`: encola un job (201). La rama debe cumplir
  `allowedBranches`; el commit se fija al encolar.
- `GET /v1/jobs`: filtros `project`, `ref`, `target`, `status` (`queued,running`), `limit` y `before` (cursor).
- `GET /v1/jobs/:id`: estado, fases y resultado.
- `POST /v1/jobs/:id/cancel`: cancela un job en cola o en ejecución (idempotente; 409 si ya terminó).

Los errores tienen la forma `{ "statusCode", "error", "message" }`; ver `docs/design.md` sección 5.

## Convenciones

- La inyección de dependencias usa `@Inject(TOKEN)` explícito en cada constructor: las pruebas corren con `tsx`, que no
  emite metadatos de tipos.
- `src/core` no importa de `adapters`; los adaptadores dependen del núcleo.
