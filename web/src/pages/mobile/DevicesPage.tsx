import { useCallback, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { DETOX_PROJECT, type DeviceStatus } from "../../api/types";
import { usePolling } from "../../usePolling";

const POLL_MS = 5000;

const STATE_BADGE: Record<DeviceStatus["state"], string> = {
  connected: "badge-success",
  disconnected: "badge-muted",
  unauthorized: "badge-danger",
};

const STATE_LABEL: Record<DeviceStatus["state"], string> = {
  connected: "Conectado",
  disconnected: "Desconectado",
  unauthorized: "No autorizado",
};

export function DevicesPage() {
  const [devices, setDevices] = useState<DeviceStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.projects
      .devices(DETOX_PROJECT)
      .then((result) => setDevices(result.devices))
      .catch((err) => setError(errorMessage(err)));
  }, []);

  usePolling(load, POLL_MS);

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Dispositivos</h2>
      </div>
      <p className="muted">Estado real de los dispositivos configurados (adb devices). Un escenario no puede arrancar si faltan los que necesita.</p>
      {error && <p className="error">{error}</p>}
      {!devices ? (
        <p className="muted">Cargando…</p>
      ) : devices.length === 0 ? (
        <p className="muted">No hay dispositivos configurados.</p>
      ) : (
        <div className="card-grid">
          {devices.map((device) => (
            <div key={device.name} className="card">
              <h3>{device.name}</h3>
              <span className={`badge ${STATE_BADGE[device.state]}`}>{STATE_LABEL[device.state]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
