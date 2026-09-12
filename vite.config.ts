import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({mode}) => ({
  root: mode === 'cloud' ? 'apps/web-cloud' : mode === 'showcase' ? 'apps/showcase' : 'apps/web-local',
  plugins: [react(), {
    name: 'verify-data-boundary',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const raw of Object.keys(chunk.modules)) {
          const id = raw.replaceAll('\\', '/');
          if (mode === 'cloud' && /\/apps\/(local|cloud|showcase)\/|\/sql\.js\/|\/modules\/(storage|collection|platform\/node|accounts\/(reader|rpc|credentials|command))\//.test(id))
            this.error(`Private local module in cloud application: ${id}`);
          if (mode === 'showcase' && /\/(?:apps\/local|modules\/(?:storage|collection|platform\/node))\//.test(id))
            this.error(`Private server module in showcase: ${id}`);
          if (mode !== 'showcase' && /\/(apps\/showcase|sql\.js)\//.test(id))
            this.error(`Example module in production application: ${id}`);
        }
      }
    },
  }],
  build: { outDir: mode === 'cloud' ? '../../cloud/build' : mode === 'showcase' ? '../../showcase/build' : '../../dist/web', emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: mode === 'showcase' ? undefined : {
      "^/api(?:/|$)": "http://127.0.0.1:8765",
      "/docs": "http://127.0.0.1:8765",
    },
  },
}));
