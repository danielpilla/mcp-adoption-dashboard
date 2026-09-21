import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { parsePort } from "./src/server/configuration/server-configuration";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const serverPort = parsePort(env.SERVER_PORT, 4173, "SERVER_PORT");
  const port = parsePort(env.PORT, 5173, "PORT");

  return {
    plugins: [react(), viteSingleFile()],
    build: {
      target: "es2022",
      cssCodeSplit: false,
      assetsInlineLimit: 100_000,
    },
    server: {
      port,
      strictPort: true,
      host: env.BIND_HOST || "127.0.0.1",
      proxy: {
        "/api": `http://127.0.0.1:${serverPort}`,
      },
    },
  };
});
