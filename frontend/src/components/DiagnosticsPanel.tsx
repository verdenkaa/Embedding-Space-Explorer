import type { CheckResult, HealthResponse } from "../api/types";
import { useUiStore } from "../state/uiStore";

const CHECK_MARKERS: Record<CheckResult["status"], string> = {
  ok: "✓",
  warn: "!",
  error: "✕",
};

function ChecksCard({ checks }: { checks: CheckResult[] }) {
  return (
    <section className="panel-card" aria-labelledby="checks-title">
      <h2 className="panel-card__title" id="checks-title">
        Проверки
      </h2>
      <ul className="check-list">
        {checks.map((check) => (
          <li key={check.name} className={`check-item check-item--${check.status}`}>
            <span className="check-item__marker" aria-hidden="true">
              {CHECK_MARKERS[check.status]}
            </span>
            <span className="check-item__name">{check.name}</span>
            <span className="check-item__detail">{check.detail}</span>
            <span className="visually-hidden" aria-live="polite">
              {check.status}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DependenciesCard({ health }: { health: HealthResponse }) {
  return (
    <section className="panel-card" aria-labelledby="deps-title">
      <h2 className="panel-card__title" id="deps-title">
        Зависимости
      </h2>
      <table className="deps-table">
        <thead>
          <tr>
            <th scope="col">Пакет</th>
            <th scope="col">Версия</th>
            <th scope="col">Статус</th>
          </tr>
        </thead>
        <tbody>
          {health.dependencies.map((dep) => (
            <tr key={dep.name}>
              <td>
                {dep.name}
                {dep.required && <span title="Обязательная зависимость"> *</span>}
              </td>
              <td>{dep.version ?? "—"}</td>
              <td>
                <span className={`badge ${dep.installed ? "badge--installed" : "badge--missing"}`}>
                  {dep.installed ? "✓ установлена" : "не установлена"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function OnlineView({ health }: { health: HealthResponse }) {
  return (
    <>
      <section className="panel-card" aria-labelledby="app-title">
        <h2 className="panel-card__title" id="app-title">
          Приложение
        </h2>
        <dl className="kv-grid">
          <dt>Название</dt>
          <dd>{health.app_name}</dd>
          <dt>Версия</dt>
          <dd>
            {health.app_version} (схема данных v{health.schema_version})
          </dd>
          <dt>Backend</dt>
          <dd>
            http://{health.server_host}:{health.server_port}
            {health.loopback_only ? " — только локально" : " — ВНИМАНИЕ: доступен из сети"}
          </dd>
          <dt>Статус</dt>
          <dd>{health.status}</dd>
        </dl>
      </section>

      <section className="panel-card" aria-labelledby="runtime-title">
        <h2 className="panel-card__title" id="runtime-title">
          Окружение
        </h2>
        <dl className="kv-grid">
          <dt>Python</dt>
          <dd>{health.python_version}</dd>
          <dt>Платформа</dt>
          <dd>{health.platform}</dd>
          <dt>Каталог данных</dt>
          <dd title={health.data_dir}>{health.data_dir}</dd>
        </dl>
      </section>

      <ChecksCard checks={health.checks} />
      <DependenciesCard health={health} />
    </>
  );
}

function OfflineView() {
  const error = useUiStore((s) => s.error);
  const refreshHealth = useUiStore((s) => s.refreshHealth);

  return (
    <div className="state-block state-block--error" role="alert">
      <h2 className="state-block__title">Backend недоступен</h2>
      <p className="state-block__message">{error?.message ?? "Не удалось получить диагностику."}</p>
      {error?.hint && <p className="state-block__hint">{error.hint}</p>}
      <p className="state-block__hint">Ручной запуск backend (из каталога backend/):</p>
      <pre className="state-block__code">
        {".venv\\Scripts\\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000"}
      </pre>
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => void refreshHealth({ interactive: true })}
      >
        Повторить
      </button>
    </div>
  );
}

function LoadingView() {
  return (
    <div className="state-block" role="status">
      <h2 className="state-block__title">
        <span className="spinner" aria-hidden="true" />
        Подключение к backend…
      </h2>
      <p className="state-block__hint">
        Первый запуск может занять минуту: скрипт устанавливает зависимости.
      </p>
    </div>
  );
}

/** Main view: live backend diagnostics in the dark-IDE style. */
export function DiagnosticsPanel() {
  const connection = useUiStore((s) => s.connection);
  const health = useUiStore((s) => s.health);

  return (
    <div className="diagnostics">
      <div className="diagnostics__header">
        <h1 className="diagnostics__title">Диагностика</h1>
        <p className="diagnostics__subtitle">
          Состояние локального backend (FastAPI, только 127.0.0.1): версии,
          проверки и зависимости приложения.
        </p>
      </div>

      {connection === "online" && health ? (
        <OnlineView health={health} />
      ) : connection === "offline" ? (
        <OfflineView />
      ) : (
        <LoadingView />
      )}
    </div>
  );
}
