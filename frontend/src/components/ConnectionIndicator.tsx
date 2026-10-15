import { useUiStore } from "../state/uiStore";

const LABELS: Record<string, string> = {
  idle: "подключение…",
  loading: "подключение…",
  online: "backend онлайн",
  offline: "backend недоступен",
};

/** Status dot + label for the backend connection. */
export function ConnectionIndicator() {
  const connection = useUiStore((s) => s.connection);
  const health = useUiStore((s) => s.health);

  const backendUrl = health
    ? `http://${health.server_host}:${health.server_port}`
    : "http://127.0.0.1:8000";

  return (
    <span
      className={`connection-indicator connection-indicator--${connection}`}
      role="status"
      aria-label={`Состояние backend: ${LABELS[connection]} (${backendUrl})`}
      title={backendUrl}
    >
      <span className="connection-indicator__dot" aria-hidden="true" />
      {LABELS[connection]}
    </span>
  );
}
