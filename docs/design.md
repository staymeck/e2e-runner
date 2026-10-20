# e2e-runner: diseño del servicio

Estado: borrador para revisión (STA-26). Detox (mobile) es el primer proyecto; Cucumber (web) llega en el hito M5.

## 1. Objetivo

Un servicio independiente que encola, ejecuta y supervisa corridas E2E, con una API, logs en vivo y una web.
Hoy esto vive dentro de la librería del orquestador (`perfect-e2e-orchestrator/api` y `web`). El servicio lo reemplaza
y la librería queda solo con devices, órdenes, argumentos y CLI (STA-39).

Problemas que resuelve:
- Elegir rama y escenario sin acceso al repo ni a la máquina del lab.
- Un historial de jobs que sobrevive reinicios (hoy: mapa en memoria + `meta.json`).
- Cambiar de rama para consultar sin romper un job en ejecución.

No es objetivo: ejecutar varios jobs de Detox en paralelo (los dispositivos y puertos WS son físicos), ni
contenerizar el servicio (necesita `adb`/USB y el socket de Docker del host).

## 2. Núcleo y adaptadores

```
        ┌────────────── núcleo (común) ──────────────┐
 API ──▶│ jobs + cola (SQLite) · bloqueos · logs · auth │
 Web ──▶│ registro de proyectos · gestor de repos      │
        └───────────────┬──────────────────────────────┘
                        │ ProjectAdapter
              ┌─────────┴─────────┐
        DetoxAdapter (M3)    CucumberAdapter (M5)
```

El núcleo no conoce Detox ni Cucumber. Todo lo específico (escenarios, APK, dispositivos, cómo se interpreta un
resultado, qué reportes se publican) vive en el adaptador.

### 2.1 Interfaz `ProjectAdapter`

```ts
interface ProjectAdapter {
  readonly id: string;                       // "detox"
  readonly locks: readonly string[];         // recursos que un job exclusivo necesita: ["devices"]
  listTargets(ref: RepoRef): Promise<Target[]>;               // escenarios de una rama
  prepare(job: JobContext, sink: LogSink): Promise<void>;     // checkout del commit fijado, dependencias
  start(job: JobContext, sink: LogSink): Promise<RunHandle>;  // devuelve algo que se puede esperar y cancelar
  cancel(handle: RunHandle): Promise<void>;
  cleanup(job: JobContext): Promise<void>;                    // idempotente, nunca lanza
  collectArtifacts(job: JobContext): Promise<Artifact[]>;     // reportes y evidencia
}
```

Reglas:
- `cleanup` es idempotente y se llama siempre (éxito, fallo, cancelación o reinicio del servicio).
- Un adaptador nunca escribe en la base de datos: devuelve datos y el núcleo los guarda.
- Interfaces pequeñas y separadas por rol (`TargetCatalog`, `RunExecutor`, `ArtifactCollector`) para que el núcleo
  dependa solo de lo que usa (SOLID: segregación e inversión de dependencias). `ProjectAdapter` es su composición.

### 2.2 Bloqueos por recurso

Cada job declara los recursos que necesita (`locks`). Un job arranca cuando todos están libres. Para Detox,
`devices` es exclusivo: un job a la vez. Dos jobs sin recursos en común corren en paralelo (útil en M5).
Orden FIFO. El bloqueo vive en SQLite (tabla `locks`), así que sobrevive a reinicios y se reconcilia al arrancar.

### 2.3 Registro de proyectos

Un YAML por instalación (`E2E_SERVICE_CONFIG`), validado al arrancar:

```yaml
projects:
  detox:
    adapter: detox
    repo: git@git.example.com:formos/detox-testing.git
    allowedBranches: ["iteration_*", "main"]
    defaultBranch: iteration_1
```

Los directorios de trabajo no van en el YAML sino en variables de entorno (sección 3).

## 3. Repositorios del catálogo: dos carpetas fijas

Quien despliega crea dos carpetas, árboles de trabajo del mismo repo (`git worktree` sobre un espejo común):

| Variable | Uso | Quién la mueve de rama |
|---|---|---|
| `E2E_DETOX_RUNNER_DIR` | ejecutar jobs | solo el runner, **entre jobs** |
| `E2E_DETOX_INFO_DIR` | consultar ramas y escenarios en la web | solo la ventana Configuración |

Reglas:
1. Siempre en modo detached. Nunca se hace `checkout <rama>` por nombre.
2. **Validación al arrancar** (el servicio se niega a iniciar con un mensaje claro): ambas existen, son árboles de
   Git del mismo remoto, contienen `orch.rc.json`, y son **distintas**: se comparan rutas reales (`realpath`,
   sin distinguir mayúsculas en Windows/macOS), y se rechaza que sean iguales, que una contenga a la otra o que
   sean enlaces a la misma carpeta.
3. El commit se resuelve y se **fija al encolar** (`ref` → `sha`). El job corre siempre con ese sha, aunque haya
   habido `fetch` después. Reintentar usa el mismo sha.
4. `prepareRun(sha)` solo se ejecuta cuando el runner está libre. Hace `checkout --detach <sha>` y `npm install`
   solo si cambió el hash del lockfile.
5. La carpeta de consulta puede cambiar de rama aunque haya un job corriendo: no comparten árbol de trabajo.
6. El acceso a los repos usa una llave de despliegue **de solo lectura**. El servicio solo lee.

Interfaz estable para poder pasar luego a una carpeta por commit sin tocar el resto:

```ts
interface CatalogWorkspaces {
  fetch(): Promise<void>;
  branches(): Promise<string[]>;                    // ya filtradas por allowedBranches
  resolve(ref: string): Promise<string>;            // ref → sha
  browse(ref: string): Promise<Workspace>;          // carpeta de consulta posicionada en ref
  prepareRun(sha: string): Promise<Workspace>;      // carpeta de ejecución posicionada en sha
}
```

## 4. Modelo de datos (SQLite)

Base de datos única: SQLite en `E2E_SERVICE_DATA_DIR/service.sqlite`, vía `node:sqlite` (incluido en Node 22, sin
dependencias). Modo WAL para que las lecturas no bloqueen al runner. Logs y reportes siguen siendo archivos; la base
guarda solo sus rutas.

```
jobs(
  id TEXT PRIMARY KEY,            -- uuid
  project TEXT NOT NULL,          -- "detox"
  status TEXT NOT NULL,           -- queued | running | succeeded | failed | cancelled
  ref TEXT NOT NULL,              -- rama pedida
  sha TEXT NOT NULL,              -- commit fijado al encolar
  target TEXT NOT NULL,           -- escenario
  params TEXT NOT NULL,           -- JSON validado
  locks TEXT NOT NULL,            -- JSON: ["devices"]
  retry_of TEXT,                  -- job original si es un reintento
  created_at, started_at, finished_at,
  exit_code INTEGER, outcome TEXT, error TEXT,
  log_path TEXT, report_path TEXT
)
-- índices: (project, ref), (project, target, created_at), (status, created_at)

locks(resource TEXT PRIMARY KEY, job_id TEXT NOT NULL)
schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT)
```

Migraciones versionadas desde el primer día (archivos `.sql` numerados, cada una en una transacción).

Transiciones válidas: `queued → running | cancelled`, `running → succeeded | failed | cancelled`. Cualquier otra se
rechaza en el repositorio de jobs. **Reconciliación al arrancar:** un job `running` huérfano pasa a `failed`
("servicio reiniciado") tras `cleanup`, se liberan sus bloqueos y la cola `queued` se conserva.

## 5. API v1

Todas bajo `/v1`, JSON, autenticación obligatoria por API key (`Authorization: Bearer`); el servicio no arranca sin
clave configurada. El WebSocket también autentica.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | estado del servicio |
| GET | `/projects` | proyectos y ramas permitidas |
| POST | `/detox/fetch` | trae ramas nuevas del remoto |
| GET | `/detox/branches` | ramas permitidas |
| POST | `/detox/browse` `{ref}` | posiciona la carpeta de consulta |
| GET | `/detox/scenarios` | escenarios de la rama consultada |
| POST | `/jobs` `{project, ref, target, params?}` | resuelve el sha, valida y encola |
| GET | `/jobs` | filtros: project, ref, target, status |
| GET | `/jobs/:id` | estado, fase, resultado |
| POST | `/jobs/:id/cancel` | cancela (cola o ejecución) |
| POST | `/jobs/:id/retry` | nuevo job con el mismo sha y parámetros |
| GET | `/jobs/:id/log` | log completo; WS `/v1/jobs/:id/stream` para vivo + repetición |

## 6. Seguridad

- **El cliente nunca envía comandos ni rutas**: solo ids de proyecto, ref y escenario, que el servicio valida contra
  el registro y el catálogo. Los comandos los construye el adaptador con argumentos en arreglo (sin shell).
- Rama permitida solo si coincide con `allowedBranches`; el `ref` se valida antes de pasarse a git (sin guiones
  iniciales, sin `..`).
- Los secretos nunca se guardan ni se imprimen: los logs pasan por un redactor (mismo criterio que Cucumber:
  variables `*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*API_KEY*`).
- Rutas de reportes y logs se sirven por id de job, nunca por una ruta que mande el cliente.
- El servicio solo lee de los repos remotos (llave de solo lectura).

## 7. Estructura del repo

```
src/
  core/        jobs, cola, bloqueos, reconciliación (sin imports de adaptadores)
  db/          conexión SQLite, migraciones, repositorios
  api/         controladores, guard de auth, WebSocket
  config/      carga y validación de configuración
  repos/       CatalogWorkspaces (git)
  adapters/
    detox/     DetoxAdapter
  logging/     LogSink, redactor
web/           dashboard (React/Vite)
docs/
test/          node:test
```

Regla de dependencias: `adapters` → `core` (nunca al revés); `api` → `core`; `core` depende solo de interfaces.

## 8. Pruebas

`node:test` + `tsx`, sin librerías de prueba externas. Bases SQLite temporales, git real sobre repos temporales
(sin red) y adaptadores falsos para probar la cola. Cada ticket entrega sus pruebas; los casos de seguridad
(validación de refs, carpetas iguales o anidadas, transiciones inválidas) tienen prueba propia.

## 9. Despliegue

En el mismo host del lab que los dispositivos (necesita `adb`/USB y Docker del host), como proceso del sistema
(systemd o launchd), detrás de nginx. Variables: `E2E_DETOX_RUNNER_DIR`, `E2E_DETOX_INFO_DIR`,
`E2E_SERVICE_DATA_DIR`, `E2E_SERVICE_CONFIG`, `E2E_SERVICE_API_KEY`. Runbook en STA-36.

## 10. Evolución prevista

- Una carpeta por commit (pool de worktrees) detrás de `CatalogWorkspaces`, si hace falta ejecutar en paralelo.
- Plan de APK por job con rama por app, y caché de APK por (app, commit, host, puerto) (M4).
- Adaptador de Cucumber con bloqueo `cucumber` y reutilización de su CLI (`e2e_runner`) (M5).

## 11. Decisiones tomadas

| Decisión | Motivo |
|---|---|
| Dos carpetas fijas | Consultar otra rama no puede afectar al job en ejecución |
| Commit fijado al encolar | Lo que se vio al encolar es lo que corre |
| SQLite con `node:sqlite` | Sin servidor ni dependencias; suficiente para una cola de un solo host |
| Un job de Detox a la vez | Dispositivos y puertos WS son físicos |
| Servicio fuera de Docker | Necesita `adb`/USB y el socket de Docker del host |
| Adaptador sin acceso a la base | Mantiene el núcleo como única fuente de verdad |

## 12. Preguntas abiertas

- `node:sqlite` es experimental en Node 22: si el host usa una versión sin él, la alternativa es `better-sqlite3`
  (dependencia externa; requiere aprobación).
- Autenticación de la web: hoy una sola API key compartida; usuarios individuales quedan fuera de alcance.
