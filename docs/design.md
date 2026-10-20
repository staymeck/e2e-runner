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

Fuera de alcance: ejecutar varios jobs de Detox en paralelo (dispositivos y puertos WS son físicos), contenerizar el
servicio (necesita `adb`/USB y el socket de Docker del host) y usuarios individuales (hay una clave compartida).

### 1.1 Lo que el orquestador tiene hoy y qué pasa con ello

| Función del orquestador | En el servicio |
|---|---|
| Jobs `run`/`build`/`pipeline` con fases ordenadas y `outcome` success/warning/failure | Modelo de fases (sección 4), `outcome` con los mismos valores |
| Webhooks firmados HMAC + guard de URL (SSRF) | STA-32 (M4): portados tal cual; n8n depende de ellos |
| Token por job (`?token=`) para abrir log y reporte desde un enlace | Se conserva: token de solo lectura, por job, con expiración (sección 6) |
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
   `orch.rc.json` se exige en cada `prepareRun`/`browse` (depende del commit), no al arrancar.
3. El commit se resuelve y se **fija al encolar** (`ref` -> `sha`). El job corre siempre con ese sha; reintentar usa el
   mismo. Para que un `gc` o un force-push no lo borre, al fijarlo se crea `refs/e2e/jobs/<id>` y se elimina cuando
   el job termina y deja de poder reintentarse (política de retención en STA-28).
4. `resolve` solo acepta nombres de rama: valida con `git check-ref-format --branch`, aplica `allowedBranches` y
   resuelve `refs/remotes/origin/<rama>^{commit}`. Etiquetas y shas directos no se aceptan como `ref`. Todos los
   comandos git llevan `--end-of-options` antes de refs y el sha se vuelve a validar (`^[0-9a-f]{40}$`).
5. `prepareRun(sha)` solo se ejecuta cuando el runner está libre: `checkout --detach -f`, `clean -fdx` (conservando
   `node_modules` y `builds/`) y `npm ci` si cambió el hash del lockfile, falta `node_modules` o cambió la versión de
   Node. `npm ci` ejecuta scripts del repositorio como el usuario del servicio: quien pueda subir a una rama permitida
   puede ejecutar código en el host del lab; `allowedBranches` es un control de seguridad, no solo de comodidad.
6. Todas las operaciones git sobre el repositorio compartido van detrás de **un mutex en el proceso**
   (`fetch`, `browse`, `prepareRun`, `pin`): comparten refs y paquetes y pueden pelear por `packed-refs.lock`.
7. La carpeta de consulta puede cambiar de rama con un job corriendo: no comparten árbol de trabajo.
8. Acceso a los repos con llave de despliegue **de solo lectura**. Se documenta como responsabilidad del despliegue
   (STA-36); el servicio nunca hace `push`.

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
| 409 | `job_finished`, `invalid_transition` | cancelar un job ya terminado |
| 413 | `payload_too_large` | cuerpo mayor de 64 KB |
| 422 | `ref_not_found` | rama permitida que no existe (un `fetch` puede traerla) |
| 500 | `internal_error` | cualquier otro; el detalle va al log, nunca al cliente |

La respuesta de un job no incluye rutas del servidor (`log_path`, `report_path`) ni el `pid`.

## 6. Seguridad

- **Auth:** API key obligatoria (`Authorization: Bearer`), comparada con `timingSafeEqual`; el servicio no arranca sin
  clave y acepta dos claves a la vez para poder rotarla. Los navegadores no pueden poner cabeceras en un WebSocket:
  se usa un **ticket de un solo uso y vida corta**, obtenido con un POST autenticado; la clave de larga vida nunca va
  en la URL (nginx la registraría).
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

Framework: NestJS para la API (aprobado). `ws` solo si el adaptador de WebSocket de Nest no basta. La web
(React/Vite, como la del orquestador) **está pendiente de aprobación** como dependencia; hasta entonces STA-34 no la
empieza.

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

## 12. Preguntas abiertas

- Aprobar React/Vite para la web (STA-34).
- Retención de las refs `refs/e2e/jobs/*` y de logs/reportes antiguos (se resuelve en STA-28 y STA-36).
- Idioma de la documentación: este documento está en español; el código y los identificadores, en inglés.
