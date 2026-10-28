# Despliegue manual de `e2e-runner`

Sin pipeline todavía — estos pasos son a mano, en el host del lab (el que tiene los dispositivos USB,
`adb` y Docker). Ver `docs/design.md` §9 para el porqué del servicio fuera de Docker.

## 1. Preparar el host

- Node >= 22.13 (vía `nvm`, igual que en desarrollo).
- Python 3 con `PyYAML` + `python-dotenv` (lo usa `build-apk.py`, dentro del orquestador que instala
  cada catálogo) — `start-e2e-runner.sh` lo instala solo si falta, pero necesita un `python3` real en el `PATH`.
  `ANDROID_HOME` apuntando al SDK de Android con `adb`.
- Docker Desktop (Mac) o Docker Engine (Linux), corriendo.
- Las dos carpetas del catálogo Detox ya preparadas como worktrees (ver el README principal, sección
  "Crear las dos carpetas de Detox").

## 2. Clonar y compilar

```bash
git clone <repo> e2e-runner && cd e2e-runner
npm ci
npm run build
cp .env.example .env && $EDITOR .env   # completar cada variable — ver .env.example
```

## 3. Instalar como servicio

- **macOS**: editar `WorkingDirectory`/rutas en `com.perfect.e2e-runner.plist`, copiarlo a
  `~/Library/LaunchAgents/`, `launchctl load -w ...`. Ver los comentarios del propio archivo.
- **Linux**: editar `e2e-runner.service`, copiarlo a `/etc/systemd/system/`, `systemctl enable --now`.

Los dos arrancan siempre a través de `start-e2e-runner.sh` — launchd/systemd no cargan `~/.zshrc`, así
que ese script es el único lugar donde `nvm`/`ANDROID_HOME`/Python quedan resueltos antes de arrancar
`node dist/main.js`.

## 4. La web

Servirla por separado — ver `web/Dockerfile` (compila y sirve con nginx, reenviando `/v1/*` hacia esta
misma API vía la variable `API_UPSTREAM`). No necesita systemd/launchd: es un contenedor sin estado.

## Actualizar después de un cambio

```bash
git pull
npm ci && npm run build
launchctl kickstart -k gui/$(id -u)/com.perfect.e2e-runner   # macOS
# o: sudo systemctl restart e2e-runner                        # Linux
```
