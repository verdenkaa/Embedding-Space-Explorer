import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The backend address for the /api dev-proxy. Override with ESE_BACKEND_URL
// (environment variable or .env.local), e.g. when the backend runs on a
// non-default port: ESE_BACKEND_URL=http://127.0.0.1:8001
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "ESE_");
  const backendUrl = env.ESE_BACKEND_URL ?? "http://127.0.0.1:8000";

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: backendUrl,
          changeOrigin: false,
        },
      },
    },
  };
});
