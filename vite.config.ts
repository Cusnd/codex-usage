import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({mode}) => ({
  root: "web",
  plugins: [react(), {
    name: 'verify-data-boundary',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const raw of Object.keys(chunk.modules)) {
          const id = raw.replaceAll('\\', '/');
          if (mode === 'showcase' && /\/server\//.test(id) && !/\/server\/(queries|pricing)\.ts$/.test(id))
            this.error(`Private server module in showcase: ${id}`);
          if (mode !== 'showcase' && /\/(showcase|sql\.js)\//.test(id))
            this.error(`Example module in production application: ${id}`);
        }
      }
    },
  }],
  build: { outDir: mode === 'showcase' ? '../showcase/build' : "../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8765",
      "/docs": "http://127.0.0.1:8765",
    },
  },
}));
