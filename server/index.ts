import { createApp } from "./app.js";
const { app } = await createApp({ logger: true });
const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
try {
  await app.listen({
    host: "127.0.0.1",
    port: Number(process.env.PORT || 8765),
  });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
