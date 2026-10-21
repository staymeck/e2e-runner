# e2e-runner: diseño del servicio

Estado: borrador para revisión (STA-26), ya corregido con el review del primer borrador.
Detox (mobile) es el primer proyecto; Cucumber (web) llega en el hito M5.

## 1. Objetivo

Un servicio independiente que encola, ejecuta y supervisa corridas E2E, con una API, logs en vivo y una web.
Hoy esto vive dentro de la librería del orquestador (`perfect-e2e-orchestrator/api` y `web`). El servicio lo reemplaza
y la librería queda solo con devices, órdenes, argumentos y CLI (STA-39).

Problemas que resuelve:
- Elegir rama y escenario sin acceso al repo ni a la máquina del lab.
- Un historial de jobs que sobrevive reinicios (hoy: mapa en memoria + `meta.json`).
- Cambiar de rama para consultar sin romper un job en ejecución.

Fuera de alcance: ejecutar varios jobs de Detox en paralelo (dispositivos y puertos WS son físicos) y contenerizar el
servicio (necesita `adb`/USB y el socket de Docker del host).

**Usuarios individuales (actualizado en STA-34):** la decisión original de esta sección era "no hay, solo una clave
compartida". STA-34 la revierte a pedido del usuario: la web necesita una pantalla de login con roles
(`e2e-mobile`/`e2e-cypress`/`admin`). Ver §6 y la fila correspondiente en §11 — la clave compartida (`apiKeys`) sigue
existiendo igual que antes, sin cambios, para los clientes de máquina (CLI, futuro n8n de STA-35); los usuarios son
un mecanismo aparte, solo para la web.

### 1.1 Lo que el orquestador tiene hoy y qué pasa con ello

| Función del orquestador | En el servicio |
|---|---|
| Jobs `run`/`build`/`pipeline` con fases ordenadas y `outcome` success/warning/failure | Modelo de fases (sección 4), `outcome` con los mismos valores |
| Webhooks firmados HMAC + guard de URL (SSRF) | STA-32 (M4): portados tal cual; n8n depende de ellos |
| Token por job (`?token=`) para abrir log y reporte desde un enlace | **Superado por la decisión real de STA-31**: `GET /v1/jobs/:id/log` quedó detrás del `ApiKeyGuard` normal (Bearer), no de un token por job; solo el WS de `.../stream` tiene su propio ticket, de un solo uso y 30s. Un caller (n8n) necesita su propia API key para abrir `links.log` del webhook (STA-32) |
| Cola de un job activo | Planificador por recursos (sección 2.2) |
| Matar el árbol de procesos al cancelar (`kill-job-tree`) | Parte del adaptador de Detox (STA-38) |

## 2. Núcleo y adaptadores

```
        ┌────────────── núcleo (común) ──────────────┐
 API ──▶│ jobs + cola (SQLite) · bloqueos · logs · auth │
 Web ──▶│ registro de proyectos                        │
        └───────────────┬──────────────────────────────┘
                        │ puertos (interfaces del núcleo)
              ┌─────────┴─────────┐
        DetoxAdapter (M3)    CucumberAdapter (M5)
```

El núcleo no conoce Detox ni Cucumber. Todo lo específico (escenarios, APK, dispositivos, repos del catálogo, cómo se
interpreta un resultado, qué reportes se publican) vive en el adaptador. Los puertos (`LogSink`, `JobStore`,
`ProjectAdapter` y sus partes) se definen en `src/core`; los adaptadores dependen del núcleo, nunca al revés.

### 2.1 Puertos del adaptador

Tres interfaces pequeñas, por rol, y una composición que las agrupa con la identidad del proyecto:

```ts
interface TargetCatalog {                       // qué se puede ejecutar y de dónde
  listRefs(): Promise<string[]>;                // ramas permitidas
  fetch(): Promise<void>;
  browse(ref: string): Promise<void>;           // posiciona la consulta en ref
  listTargets(): Promise<Target[]>;             // escenarios de lo consultado
  pin(ref: string): Promise<PinnedRef>;         // resuelve ref -> sha y lo protege (sección 3)
}

interface RunExecutor {
  plan(job: JobSpec): PhaseSpec[];              // fases ordenadas: p. ej. build, scenario
  run(phase: PhaseSpec, ctx: RunContext): Promise<PhaseResult>;
  cancel(runId: string): Promise<void>;         // mata el árbol de procesos
  cleanup(runId: string): Promise<void>;        // idempotente, nunca lanza
}

interface ArtifactCollector {
  collect(runId: string): Promise<Artifact[]>;  // reportes y evidencia
}

interface ProjectAdapter {
  readonly id: string;                          // "detox"
  readonly locks: readonly string[];            // recursos exclusivos: ["devices"]
  readonly catalog: TargetCatalog;
  readonly executor: RunExecutor;
  readonly artifacts: ArtifactCollector;
  validateParams(raw: unknown): Params;         // esquema estricto, claves desconocidas rechazadas
}
```

`RunContext` solo lleva datos del job (id, sha, parámetros, directorio de salida, `LogSink`); las carpetas del catálogo
no pasan por el núcleo: las conoce el adaptador de Detox. El adaptador nunca escribe en la base de datos: devuelve
datos y el núcleo los guarda.

### 2.2 Bloqueos y planificador

- El conjunto de recursos de un job (`locks`) se fija **al encolar**, tomado de `adapter.locks`, y no cambia en
  reintentos.
- Un job arranca cuando todos sus recursos están libres. Se adquieren **todos en una transacción** (`BEGIN IMMEDIATE`);
  si falta alguno no se toma ninguno.
- Orden: llegada (`seq`), **por recurso**: un job en cabeza esperando `devices` no bloquea a uno posterior que necesita
  solo `cucumber`. El planificador recorre la cola en orden y arranca todo lo que cabe.
- Un job en cola de un proyecto sin adaptador **se conserva** (aviso una vez): el proyecto puede faltar solo en esta
  configuración. Un fallo al arrancar un job concreto lo marca `failed` sin detener al resto de la cola.
- **Un job que no termina no bloquea la cola para siempre.** El `RunContext` lleva un `AbortSignal` que se aborta al
  cancelar o agotar el tiempo de la fase (no se puede perder, a diferencia de `executor.cancel`, que mata los
  procesos). Tras cancelar hay un plazo de gracia (30 s) y, pasado, el planificador abandona la fase, llama a
  `cleanup` y termina el job. El límite por fase es opcional (`phaseTimeoutMs`): una compilación de APK puede tardar.
- Al apagar el servicio los jobs en ejecución se **cancelan** (terminan `cancelled`, no huérfanos) y se espera hasta
  10 s antes de cerrar la base; lo que quede lo concilia el siguiente arranque.
- Para Detox `devices` es exclusivo: un job a la vez. El paralelismo entre proyectos llega en M5; requiere un
  planificador (no el `shiftNext` del orquestador).

### 2.3 Registro de proyectos

Un archivo JSON por instalación (`E2E_SERVICE_CONFIG`), validado al arrancar. Es JSON y no YAML porque leer YAML
exige una dependencia que no está aprobada; el formato queda aislado en la carga de configuración, así que
cambiarlo después es un cambio local.

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

`*` no cruza `/` y se aplica sobre el nombre de rama. `defaultBranch` es la rama que Configuración muestra al abrir y
debe cumplir `allowedBranches`. Los directorios de trabajo van en variables de entorno del adaptador (sección 3), no en
este archivo.

## 3. Repositorios del catálogo de Detox: dos carpetas fijas

Esto es del adaptador de Detox (implementa `TargetCatalog`). Quien despliega crea **dos worktrees** del mismo
repositorio, con `git worktree add --detach <carpeta> <sha>` desde un espejo común (`git clone --mirror` o un clon
base). No sirve crear carpetas vacías ni dos clones.

| Variable | Uso | Quién la mueve |
|---|---|---|
| `E2E_DETOX_RUNNER_DIR` | ejecutar jobs | solo el runner, **entre jobs** |
| `E2E_DETOX_INFO_DIR` | consultar ramas y escenarios en la web | solo Configuración |

Reglas:
1. Siempre detached. Una rama solo puede estar sacada en un worktree a la vez, mientras que cualquier número de
   worktrees puede estar en commits sueltos: por eso nunca se hace `checkout <rama>` por nombre.
2. **Validación al arrancar** (el servicio se niega a iniciar con un mensaje claro): ambas existen, ambas son worktrees
   del mismo repositorio (`git rev-parse --git-common-dir` idéntico, así un `fetch` sirve a las dos), y son
   **distintas**: se comparan rutas reales (`realpath`, sin distinguir mayúsculas donde el sistema no lo hace) y se
   rechaza que sean la misma, que una contenga a la otra o que sean enlaces a la misma carpeta.
   También se comprueba que cada carpeta sea la **raíz** de un árbol de trabajo (no una subcarpeta), que esté **limpia**
   (la carpeta de ejecución se resetea antes de cada job: un clon de desarrollo con trabajo sin guardar se rechaza al
   arrancar, no se borra después), que `origin` sea el repositorio configurado del proyecto (se comparan como
   `host/ruta`, sin credenciales, esquema, puerto ni `.git`) y que tenga `orch.rc.json` (en cada `prepareRun`/`browse`
   se vuelve a exigir, porque depende del commit). `E2E_SERVICE_DATA_DIR` no puede estar dentro de ninguna de las dos.
3. El commit se resuelve y se **fija al encolar** (`ref` -> `sha`). El job corre siempre con ese sha; reintentar usa el
   mismo. Para que un `gc` o un force-push no lo borre, al fijarlo se crea `refs/e2e/pins/<sha>` (por commit, no por
   job: varios jobs pueden compartirlo). `release(sha)` lo quita si el job no llegó a crearse y `prunePins(keep)`
   libera todos los que ningún job necesita; la política de retención (cuánto tiempo se puede reintentar un job)
   decide qué conjunto `keep` se pasa, y se cablea con el despliegue (STA-36).
4. `resolve` solo acepta nombres de rama: valida la forma (como `check-ref-format`, sin `HEAD`), aplica
   `allowedBranches` y resuelve `refs/remotes/origin/<rama>^{commit}`. Etiquetas, `HEAD` y shas directos no se aceptan
   como `ref`. Un commit se vuelve a validar como `^[0-9a-f]{40}$` antes de cada comando git y los comandos se ejecutan
   con la lista de argumentos, sin shell.
5. `prepareRun(sha)` solo se ejecuta cuando el runner está libre (su único llamador es el ejecutor de Detox, que el
   planificador corre de a un job por el recurso `devices`) y **solo para un commit fijado** con `pin` (`refs/e2e/pins`):
   eso demuestra que vino de una rama permitida y que sigue existiendo, y cierra el hueco entre fijar y ejecutar.
   Hace `checkout --detach --force` y `clean -ffd` (se borran las ediciones, los archivos sin seguimiento y los
   repositorios anidados; los **ignorados**, como `node_modules`, `builds/`, `.env` y los reportes, se conservan) y
   `npm ci` si cambió el hash del lockfile, falta `node_modules` o cambió la versión de Node o la plataforma (la marca
   vive dentro de `node_modules`, así que borrarlo fuerza una instalación nueva; sin `package-lock.json` se rechaza).
   Toda la preparación tiene su propio cerrojo: dos preparaciones nunca se intercalan, y navegar o hacer `fetch` (el
   mutex de git) no espera a la instalación. `npm ci` ejecuta scripts del repositorio como el usuario del servicio:
   quien pueda subir a una rama permitida puede ejecutar código en el host del lab; `allowedBranches` es un control de
   seguridad, no solo de comodidad. Por eso se ejecuta con un entorno **mínimo** (sin los secretos del servicio) y con
   `--include=dev` aunque `NODE_ENV=production`. El servicio se despliega en Linux o macOS: en Windows `npm` es un
   `.cmd` que Node no lanza sin shell.
6. Todas las operaciones git sobre el repositorio compartido van detrás de **un mutex en el proceso**
   (`fetch`, `browse`, `prepareRun`, `pin`): comparten refs y paquetes y pueden pelear por `packed-refs.lock`.
7. La carpeta de consulta puede cambiar de rama con un job corriendo: no comparten árbol de trabajo.
8. Acceso a los repos con llave de despliegue **de solo lectura**. Se documenta como responsabilidad del despliegue
   (STA-36); el servicio nunca hace `push`. Git nunca pregunta (sin prompts, ssh en `BatchMode`), salvo que el despliegue
   fije su propio comando ssh (`GIT_SSH_COMMAND` o `core.sshCommand` con la llave): entonces no se toca. Las variables
   que redirigen git (`GIT_DIR`, `GIT_WORK_TREE`, ...) se quitan del entorno, y las URLs con credenciales no se
   repiten en los mensajes de error. Un error real de git (timeout, repositorio dañado) nunca se confunde con "no
   existe": solo el código de salida que git usa para "ausente" cuenta como respuesta.

Interfaz estable para poder pasar luego a una carpeta por commit sin tocar el resto: `TargetCatalog` (arriba) más
`prepareRun(sha)`, interno del adaptador.

## 4. Modelo de datos (SQLite)

Única base de datos: SQLite en `E2E_SERVICE_DATA_DIR/service.sqlite`, con `node:sqlite` (incluido en Node 22, sin
dependencias; es experimental, así que va detrás de una interfaz `Database` pequeña para poder cambiarlo por
`better-sqlite3`, que requeriría aprobación). Se fija `engines.node` y se documenta en el runbook. Siempre
`PRAGMA journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout`; las escrituras de reclamo usan `BEGIN IMMEDIATE`.
Logs y reportes siguen siendo archivos; la base guarda solo sus rutas.

```
jobs(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,   -- orden de llegada (los timestamps pueden coincidir)
  id TEXT NOT NULL UNIQUE,                 -- uuid
  project TEXT NOT NULL,                   -- "detox"
  kind TEXT NOT NULL,                      -- "run" | "build" | "pipeline" (lo define el adaptador)
  status TEXT NOT NULL,                    -- ver transiciones
  ref TEXT NOT NULL, sha TEXT NOT NULL,    -- rama pedida y commit fijado al encolar
  target TEXT NOT NULL,                    -- escenario (o alcance del pipeline)
  params TEXT NOT NULL,                    -- JSON validado por el adaptador
  locks TEXT NOT NULL,                     -- JSON, fijado al encolar
  retry_of TEXT REFERENCES jobs(id),
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  cancel_requested_at TEXT,
  outcome TEXT,                            -- success | warning | failure
  error TEXT,
  pid INTEGER,                             -- raíz del árbol de procesos (para limpiar tras un crash)
  log_path TEXT, report_path TEXT
)
-- índices: (project, ref), (project, target, created_at), (status, seq), (retry_of)

job_phases(
  job_id TEXT NOT NULL REFERENCES jobs(id), position INTEGER NOT NULL,
  name TEXT NOT NULL,                      -- build | scenario | ...
  status TEXT NOT NULL,                    -- pending | running | succeeded | failed | skipped | cancelled
  exit_code INTEGER, signal TEXT, outcome TEXT, started_at TEXT, finished_at TEXT,
  PRIMARY KEY (job_id, position)
)

locks(resource TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id))
schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)
```

Migraciones: objetos TypeScript numerados 1, 2, 3... (así `tsc` las incluye sin paso de copia), cada una en una
transacción que vuelve a comprobar la versión bajo el bloqueo de escritura, por si otro proceso arranca a la vez. El
servicio se niega a abrir una base más nueva que su código. Una migración que reconstruya una tabla
(`PRAGMA foreign_keys=OFF`) no puede ir dentro de una transacción: habrá que tratarla aparte.

Estados de `jobs.status`: `queued`, `running` (incluye la preparación: checkout y `npm ci` ocurren con los recursos
tomados), `cancelling`, `succeeded`, `failed`, `cancelled`.

Transiciones válidas (cualquier otra la rechaza el repositorio de jobs):
- `queued -> running | cancelled | failed` (`failed` para un job en cola cuyo commit ya no existe)
- `running -> succeeded | failed | cancelling`
- `cancelling -> cancelled | failed` (`cancel_requested_at` se fija al pasar a `cancelling`)
- Un fallo de preparación es `running -> failed`: se llama a `cleanup` y se liberan los recursos.
- El estado final debe ir respaldado por sus datos: `succeeded` exige `outcome` success o warning y todas las fases
  terminadas; `failed` exige un `error` y registra `outcome` failure. `outcome` y `error` solo se añaden, nunca se
  borran ni se sobrescriben: gana la primera causa.
- Una fase solo avanza (`pending -> running -> terminada`) y solo mientras el job está `running` o `cancelling`; al
  terminar el job, las fases abiertas pasan a `failed`/`skipped` (o `cancelled`) en la misma transacción que libera
  los recursos. Lo mismo para el `pid`: solo un job vivo puede tenerlo.
- `cancelling -> cancelling` no es una transición: el servicio lo trata como idempotente (200) leyendo antes el estado,
  y traduce la carrera con `InvalidTransitionError` a 409.
- Cancelar un job ya terminal devuelve 409; cancelar uno en `cancelling` es idempotente (200).
- Reintentar solo se permite sobre un job terminal (409 en caso contrario): crea un job nuevo con el mismo sha,
  parámetros y recursos, y `retry_of` apuntando al original.

**Reconciliación al arrancar:** por cada job `running` o `cancelling`: el adaptador recibe el `pid` registrado para
limpiar (el árbol de procesos puede seguir vivo tras un crash y mantener ocupados dispositivos y puertos). Un job
`running` pasa a `failed` ("servicio reiniciado durante la fase X") y uno `cancelling` pasa a `cancelled` (la
cancelación ya estaba pedida); en ambos casos se liberan sus recursos. La cola `queued` se conserva;
un `queued` cuyo sha ya no existe pasa a `failed` ("commit no disponible").

## 5. API v1

Todo bajo `/v1`, JSON. El nombre del proyecto va en la ruta: el núcleo no tiene rutas específicas de Detox.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/v1/health` | estado del servicio |
| GET | `/v1/projects` | proyectos y su rama por defecto |
| POST | `/v1/projects/:id/fetch` | trae ramas nuevas del remoto |
| GET | `/v1/projects/:id/refs` | ramas permitidas |
| POST | `/v1/projects/:id/browse` `{ref}` | posiciona la consulta |
| GET | `/v1/projects/:id/targets` | escenarios de lo consultado |
| POST | `/v1/jobs` `{project, target, ref?, kind?, params?}` | valida, fija el sha y encola (201) |
| GET | `/v1/jobs` | filtros project, ref, target, status (`a,b`); `limit` (1-200) y cursor `before` |
| GET | `/v1/jobs/:id` | estado, fases, resultado |
| POST | `/v1/jobs/:id/cancel` | cancela (cola o ejecución) |
| POST | `/v1/jobs/:id/retry` | nuevo job con el mismo sha y parámetros |
| GET | `/v1/jobs/:id/log?from=<byte>` | log desde un desplazamiento |
| GET | `/v1/jobs/:id/report/*` | reporte, por id de job |
| POST | `/v1/jobs/:id/stream-ticket` | ticket de un solo uso para el WebSocket |
| WS | `/v1/jobs/:id/stream?ticket=...&from=<byte>` | repetición + en vivo, sin duplicados ni huecos |

Orden de las validaciones en `POST /v1/jobs`: proyecto -> rama permitida (lista del servicio, no del adaptador) ->
`kind` -> nombre del escenario -> parámetros (esquema estricto del adaptador) -> `pin(ref)` (resuelve y protege el
commit) -> encolar. Nada se crea si falla un paso. Los campos desconocidos del cuerpo se rechazan; el cuerpo no puede
pasar de 64 KB. `ref` y `kind` son opcionales (rama por defecto del proyecto, primer `kind` del adaptador).

Errores: `{ statusCode, error, message }`.

| Código | `error` | Cuándo |
|---|---|---|
| 400 | `invalid_request` | cuerpo o filtros mal formados, escenario o parámetros inválidos |
| 401 | | falta o es inválida la API key |
| 403 | `ref_not_allowed` | rama fuera de `allowedBranches` o con nombre inseguro |
| 404 | `unknown_project`, `job_not_found` | proyecto sin configurar o sin adaptador; job inexistente |
| 404 | `catalog_unsupported` | el proyecto existe pero su adaptador no ofrece navegar su catálogo (STA-42) |
| 409 | `job_finished`, `invalid_transition` | cancelar un job ya terminado |
| 409 | `retry_not_allowed` | reintentar un job que no terminó todavía (STA-43) |
| 413 | `payload_too_large` | cuerpo mayor de 64 KB |
| 422 | `ref_not_found` | rama permitida que no existe (un `fetch` puede traerla) |
| 422 | `catalog_unavailable` | el catálogo no puede responder ahora mismo (commit sin `orch.rc.json`, rama anterior al comando `scenarios`, dependencias de esa carpeta sin instalar) — esperado, no un bug (STA-42) |
| 500 | `internal_error` | cualquier otro; el detalle va al log, nunca al cliente |

La respuesta de un job no incluye rutas del servidor (`log_path`, `report_path`) ni el `pid`. Los filtros de
`GET /v1/jobs` son estrictos: una clave desconocida (`?stauts=queued`), un valor repetido o `limit` mayor de 200 dan
400, en vez de devolver todos los jobs. Los mensajes de error de Nest y del analizador de JSON nunca se devuelven tal
cual (pueden citar la petición): solo el texto estándar del código. Se comprueban por forma y no con `instanceof`,
porque el adaptador HTTP se carga como módulo ES con su propia copia de `@nestjs/common`. El cuerpo se analiza antes de
autenticar (máximo 64 KB, y nginx limita antes); una petición sin clave con JSON roto recibe 400 en vez de 401.

Si `pin(ref)` tuvo éxito pero el job no llegó a crearse, el servicio llama a `release(sha)` para no dejar el commit
protegido sin un job que lo use.

## 6. Seguridad

- **Auth:** API key obligatoria (`Authorization: Bearer`), comparada con `timingSafeEqual`; el servicio no arranca sin
  clave y acepta dos claves a la vez para poder rotarla. Los navegadores no pueden poner cabeceras en un WebSocket:
  se usa un **ticket de un solo uso y vida corta**, obtenido con un POST autenticado; la clave de larga vida nunca va
  en la URL (nginx la registraría).
- **Login de la web (STA-34), aparte de la API key:** `POST /v1/auth/login` (username+password contra una lista fija
  en `E2E_WEB_USERS`, mismo modelo de confianza que la API key: texto plano en una variable de entorno, nunca
  logueado, comparado con `timingSafeEqual` incluso para un usuario que no existe) devuelve un token de sesión
  (`WebSessions`, en memoria, TTL de 12h — igual que `StreamTickets`, un restart desloguea a todos sin daño). Ese
  token viaja también como `Authorization: Bearer`, y `AuthGuard` (antes `ApiKeyGuard`) prueba primero la API key y
  luego una sesión: una sesión válida nunca abre más que su rol, una API key válida sigue abriendo todo (los clientes
  de máquina no cambian). `@Roles(...)` en un controlador exige uno de esos roles o `admin`; no tiene efecto sobre
  una petición con API key. `GET /v1/auth/me` y `POST /v1/auth/logout` completan el ciclo para la web (restaurar
  sesión al recargar, cerrar sesión).
- **Enlaces abribles** (log, reporte): token por job, solo lectura, con expiración, como el `accessToken` del
  orquestador. Distinto de la API key.
- **Transporte:** el servicio escucha en localhost; nginx pone TLS y el límite de tamaño de cuerpo y de tasa.
  CORS cerrado salvo el origen de la web; el WebSocket comprueba `Origin`.
- **El cliente nunca envía comandos ni rutas:** solo ids de proyecto, ref y escenario, validados contra el registro y el
  catálogo. Los comandos los construye el adaptador con argumentos en arreglo, sin shell.
- `params` lo valida cada adaptador con un esquema estricto (claves desconocidas rechazadas); el nombre de escenario
  debe existir en el catálogo y cumplir un patrón fijo.
- Refs: reglas de la sección 3 (`check-ref-format`, `allowedBranches`, `--end-of-options`). Lista blanca, no lista
  negra.
- Rutas de reportes y logs se sirven por id de job; se resuelven con `realpath` y comprobación de prefijo, rechazando
  enlaces simbólicos que salgan del directorio.
- Redacción de secretos: por nombre de variable (`*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*API_KEY*`) **y por valor** de
  los secretos configurados, también en URLs de remotos con credenciales.
- El servicio solo lee de los repos remotos (llave de solo lectura).

## 7. Estructura del repo

```
src/
  core/        jobs, planificador, bloqueos, reconciliación y los puertos (sin imports de adaptadores)
  db/          conexión SQLite, migraciones, repositorios
  api/         controladores, guards, WebSocket
  config/      carga y validación de configuración
  logging/     implementación de LogSink y redactor
  adapters/
    detox/     DetoxAdapter, repos del catálogo, dispositivos, APK
web/           dashboard
docs/
test/          node:test
```

Framework: NestJS para la API (aprobado). `ws` (STA-31, `.../stream`) va adjunto directo al `http.Server` de Nest,
no por el módulo de WebSocket de Nest (`@nestjs/websockets`/`@nestjs/platform-ws` serían dependencias nuevas sin
aprobar). La web (React/Vite, como la del orquestador) **está pendiente de aprobación** como dependencia; hasta
entonces STA-34 no la empieza.

Regla de dependencias: `adapters -> core`, `api -> core`, `db -> core`; `core` solo depende de sus propias interfaces.

## 8. Pruebas

`node:test` + `tsx`, sin librerías de prueba externas. Bases SQLite temporales, git real sobre repos temporales
(sin red) y adaptadores falsos para probar la cola y el planificador. Cada ticket entrega sus pruebas; los casos de
seguridad (refs, carpetas iguales o anidadas, transiciones inválidas, cancelación en carrera) tienen prueba propia.

## 9. Despliegue

En el mismo host del lab que los dispositivos (necesita `adb`/USB y Docker del host), como proceso del sistema
(systemd o launchd), detrás de nginx con TLS. Variables: `E2E_DETOX_RUNNER_DIR`, `E2E_DETOX_INFO_DIR`,
`E2E_SERVICE_DATA_DIR`, `E2E_SERVICE_CONFIG`, `E2E_SERVICE_API_KEY`. Runbook en STA-36.

## 10. Evolución prevista

- Una carpeta por commit (pool de worktrees) detrás de `TargetCatalog`, si hace falta ejecutar en paralelo.
- Plan de APK por job con rama por app y caché de APK por (app, commit, host, puerto) (M4).
- Adaptador de Cucumber con recurso `cucumber` y reutilización de su CLI (`e2e_runner`) (M5).

## 11. Decisiones tomadas

| Decisión | Motivo |
|---|---|
| Dos worktrees fijos, siempre detached | Consultar otra rama no puede afectar al job; una rama no puede estar en dos worktrees |
| Commit fijado al encolar, protegido con una ref | Lo que se vio al encolar es lo que corre, aunque haya force-push o `gc` |
| SQLite con `node:sqlite` tras una interfaz | Sin servidor ni dependencias; cambiable si se vuelve un problema |
| Fases por job (`job_phases`) | build + scenario y pipelines, como hoy en el orquestador |
| Bloqueos por recurso con planificador | Detox serial hoy, paralelismo entre proyectos después |
| Servicio fuera de Docker | Necesita `adb`/USB y el socket de Docker del host |
| El adaptador no escribe en la base | El núcleo es la única fuente de verdad |
| Rutas genéricas por proyecto | El núcleo no conoce Detox |
| `JobLog` real: un archivo de texto por job bajo `dataDir/logs`, sin servirlo todavía | Construido en STA-38 porque el adaptador lo necesita para no perder la salida de `perfect-qa`; servirlo por API con token y expiración es STA-31 |
| Entorno de los procesos hijos: todo `process.env` del servicio, menos `E2E_SERVICE_API_KEY`/`_NEXT` por nombre exacto | `perfect-qa` hereda lo mismo que el servicio (no corre con entorno mínimo, a diferencia de git/npm); una lista blanca rompería variables que hoy necesita y no están catalogadas |
| Puerto `ProjectCatalog` nuevo en `core/adapter.ts` (`fetch`/`refs`/`browse`/`targets`), opcional (`ProjectAdapter.browsable`), para STA-42 | El núcleo necesitaba una forma genérica de exponer el catálogo sin conocer Detox; se llamó `browsable` y no `catalog` porque `DetoxAdapter` ya usaba ese nombre para su `CatalogWorkspaces` interno |
| `targets()` siempre lista lo que el último `browse()` dejó posicionado, sin recibir una rama de nuevo | Coherente con que el servicio tiene una sola carpeta de consulta fija; `browse` y `targets` son un par con estado, igual que el resto del diseño de las dos carpetas |
| `retry` nunca vuelve a pinnear: reusa el `sha` del job original directamente, sin pasar por `refs.pin(ref)` | "Mismo commit" significa el mismo commit, no el commit actual de esa rama; `RefPinner.pin` solo resuelve por nombre de rama, así que un retry no puede (ni debe) usarlo |
| `retry` no vuelve a pasar por `isBranchAllowed`, `validateRequest` ni la lista de `kinds` del adaptador: reusa los campos del job original tal cual | Coherente con "mismo exacto" (proyecto/rama/kind/escenario/parámetros); si la política de un proyecto se endurece después, un retry de un job viejo sigue aceptándose con sus parámetros de entonces — consciente, no un descuido |
| `JobService.retry` no repite el chequeo `isTerminal` que ya hace `assertRetryable` dentro de `JobStore.create` | Eran exactamente el mismo chequeo con el mismo error; mantenerlo en `JobService` además sufría un TOCTOU (leía el estado antes de la transacción de `create`, podía rechazar un retry que para el momento de escribir ya era válido). Una sola fuente de verdad, más permisiva-correcta |
| `ws` (no `@nestjs/websockets`/`@nestjs/platform-ws`) adjuntado directo al `http.Server` de Nest, fuera de su pipeline de peticiones | `ws` ya estaba aprobado; el paquete de WebSocket de Nest sería una dependencia nueva sin aprobar. El handshake de WS no puede llevar `Authorization`, así que de todas formas necesitaba su propio control de acceso (el ticket), no el `ApiKeyGuard` |
| Ticket de un solo uso para `.../stream` en memoria (`StreamTickets`), nunca en SQLite | Vive segundos (`DEFAULT_TICKET_TTL_MS` = 30s); un restart del servicio invalidando tickets abiertos es inofensivo, igual que las API keys. `issue()` barre los vencidos sin consumir, para no crecer sin límite si un cliente pide un ticket y nunca conecta |
| `GET /v1/jobs/:id/log` sigue detrás del `ApiKeyGuard` normal (Bearer), no de un ticket | Un `fetch`/XHR sí puede llevar cabeceras; solo el handshake de WebSocket no puede. El "token por corrida, de solo lectura" que promete la sección 6 para un enlace abierto sin cabeceras (p. ej. pegado en la barra del navegador) no se implementó: no lo pidió este ticket |
| La cola de replay + en vivo de `.../stream` hace *polling* del archivo (`JobLogReader.read`) cada `pollMs` (300ms por defecto), no `fs.watch` | Simple y predecible entre Linux y macOS (los únicos dos donde se despliega); `fs.watch` es notoriamente inconsistente entre sistemas de archivos. El costo es hasta 300ms de retraso en lo "en vivo", aceptable para logs de diagnóstico |
| `FileJobLog.read` no está protegido por ningún lock de escritura: puede en teoría leer un `append` a medio escribir | `fs.appendFileSync` escribe de un solo `write()` casi siempre; el riesgo de partir una escritura es mínimo y el costo de un lock de lectura/escritura alrededor de cada línea de log no se justifica para un flujo de diagnóstico, no de datos críticos |
| Cada conexión de `.../stream` registra `ws.on("error", ...)` | Un frame malformado del cliente hace que `ws` emita `'error'`; sin ningún listener, Node lo trata como excepción no capturada y tumba **todo el proceso** (todos los jobs, no solo esa conexión). Encontrado por el agente de review, confirmado con una prueba real (socket crudo que manda un frame sin máscara) |
| Ping/pong cada `pingMs` (30s por defecto) en `.../stream`, con `ws.terminate()` si no hay `pong` a tiempo | Un cliente que desaparece sin cerrar la conexión TCP (red caída, laptop suspendida) quedaba "abierto" y en *polling* hasta que el job terminara, por minutos; el keepalive lo libera mucho antes |
| El cierre limpio de `.../stream` en el apagado usa el hook `beforeApplicationShutdown` de Nest (`src/lifecycle/log-stream-shutdown.ts`), no un envoltorio de `app.close` ni el evento `"close"` del `http.Server` | Nest envuelve cada método público de la app (incluido `close`) en un proxy que vuelve a resolver el método por nombre en cada llamada; capturar "el close original" con `app.close.bind(app)` y llamarlo desde un reemplazo entra en recursión infinita. El evento `"close"` del `http.Server` tampoco sirve: el propio `close()` de Express ya destruyó a la fuerza los sockets (los WS incluidos) antes de que ese evento dispare. `beforeApplicationShutdown` es el único punto que Nest corre antes de eso |
| STA-32: `src/webhooks/` porta `sign.ts`/`subscribers.ts`/`url-guard.ts` del orquestador casi sin cambios (solo la variable de entorno pasa a `E2E_WEBHOOK_SUBSCRIBERS` y `assertWebhookUrlAllowed` lanza su propio `WebhookUrlNotAllowedError` en vez de `BadRequestException` de Nest, porque esta carpeta no debe depender del framework HTTP) | Son piezas de seguridad (HMAC, SSRF) sin acoplamiento al modelo de datos del orquestador; portarlas tal cual es lo correcto |
| `payload.ts` no es un port, es una reconstrucción para el modelo de `Job` de este servicio: no hay `deriveOutcome` ni escaneo de `reports.json`/`summary.json` | El `Job`/`JobPhase` de este servicio ya guardan `outcome` y el estado de cada fase de forma estructurada (lo calculó el adaptador al correr); el orquestador necesitaba derivarlo de archivos porque su modelo no lo tenía. Reconstruir esa derivación acá sería lógica muerta |
| El payload de STA-32 no tiene `label` ni `?token=` en los links (diferencias documentadas, permitidas por el propio ticket) | Sin campo `label` equivalente en el `Job` de este servicio; sin token de larga vida por job (ver fila de la sección 1.1) — un consumidor (n8n) usa su propia API key para abrir `links.log` |
| `postJobWebhookEvent` (dispatch) no está cableado a ningún lugar todavía: nada en el scheduler lo llama | Decidir cuándo disparar `started`/`finished` (¿por job, por fase?) y de dónde sale la `webhookUrl` de un job es STA-35 ("Integrar n8n"), no STA-32; esta pieza queda lista para que STA-35 la use |
| `test/webhook-dispatch.test.ts` solo prueba el camino de fallo (host `.invalid`, nunca resuelve) | El original del orquestador no tenía ninguna prueba de `dispatch.ts` (solo `sign`/`url-guard`/`payload`, igual que pide el criterio de aceptación de STA-32), y `assertWebhookDestinationSafe` bloquea `127.0.0.1` a propósito (anti-SSRF), así que un servidor de prueba local sería rechazado como el ataque real que el guard previene. El camino de éxito (un POST real a un receptor) no tiene prueba aquí; queda para cuando STA-35 cablee esto contra un receptor de verdad |
| `postJobWebhookEvent` recibe un `Diagnostics` genérico opcional (silencioso por defecto) y loguea cada entrega fallida | El original logueaba con el `Logger` de Nest; como esta carpeta no debe depender de Nest, se perdía toda visibilidad de fallos de webhook. El agente de review lo marcó como should-fix; se corrigió reusando la interfaz `Diagnostics` que ya existe en `core/` |
| `fetch` sigue redirects 3xx sin volver a pasar la URL final por `assertWebhookDestinationSafe` | Hueco de SSRF heredado del original (no introducido aquí: el orquestador tampoco fijaba `redirect: "manual"`). Si un subscriptor legítimo responde con una redirección hacia una IP interna, `fetch` la sigue sin re-validar. Queda para STA-35: fijar `redirect: "manual"` y tratar cualquier 3xx como fallo al cablear el dispatch real |
| STA-34: `E2E_WEB_USERS` es una lista fija en texto plano (`usuario:password:rol`, separada por comas; el password puede contener `:`, solo el usuario y el rol no), no una tabla en SQLite | El usuario eligió este modelo explícitamente (mismo nivel de confianza que `E2E_SERVICE_API_KEY`, sin alta/gestión propia); evita una dependencia nueva de hashing (bcrypt/argon2) y migra nada en la base. Se agregó a `SERVICE_SECRET_NAMES` para que nunca llegue a un proceso hijo de Detox, el mismo bug que se encontró y arregló en STA-38 |
| `WebSessions` en memoria (no SQLite), TTL fijo de 12h, igual patrón que `StreamTickets` | Un restart del servicio desloguea a todos sin daño (solo hay que volver a entrar); nada fuera de este proceso necesita leer una sesión. Evita una tabla nueva y la complejidad de session storage distribuido, que no hace falta para un solo proceso |
| `AuthGuard` reemplaza a `ApiKeyGuard` como `APP_GUARD`: prueba la API key primero, luego una sesión de usuario | Una sola puerta de entrada en vez de dos guards encadenados; una petición con API key sigue abriendo todo (sin romper la CLI ni el futuro n8n de STA-35), y `@Roles(...)` solo restringe una sesión de usuario, nunca una API key |
| `admin` no tiene ningún permiso adicional hoy, más allá de que no lo bloquea ningún `@Roles(...)` | El usuario lo pidió así explícitamente ("nada más por ahora"); si más adelante necesita gestionar usuarios o actuar sobre jobs de otros, es una decisión nueva, no asumida de antemano |
| `ProjectsController` y `JobsController` llevan `@Roles("e2e-mobile")` a nivel de clase | Hoy Detox es el único proyecto; un usuario `e2e-cypress` no tiene nada que hacer ahí todavía (Cypress no está construido). Es a propósito más estricto que "ocultar en la UI": el rol se exige también en el servidor |
| `AuthGuard` inyecta `Reflector` con `@Inject(Reflector)` explícito, no por tipo | `tsx`/esbuild no emite `design:paramtypes`; sin un token explícito, Nest no puede resolverlo y el guard fallaba con un 500 en **cada** petición (encontrado al correr la batería de pruebas tras implementarlo, antes de la revisión) |

## 12. Preguntas abiertas

- Retención de las refs `refs/e2e/jobs/*` y de logs/reportes antiguos (se resuelve en STA-28 y STA-36).
- Idioma de la documentación: este documento está en español; el código y los identificadores, en inglés.
- Redacción de secretos **por valor** en los logs de job (la sección 6 la promete; STA-38 solo filtra por nombre de
  variable antes de arrancar el proceso, no inspecciona lo que `perfect-qa` imprime). Revisar antes de exponer los
  logs por la web o por API (STA-31), por si algo imprime un secreto que no sea la API key del servicio.
- STA-43 menciona "los logs de cualquier job siguen disponibles siempre (en vivo si corre, repetición si terminó)"
  en su alcance; eso es exactamente lo que entrega STA-31 (`GET /v1/jobs/:id/log` y el WebSocket). STA-43 en sí
  solo agrega `retry`; servir el log de un job ya escrito por `FileJobLog` queda para STA-31, no se adelantó aquí.
