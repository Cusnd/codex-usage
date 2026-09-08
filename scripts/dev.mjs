import { spawn } from "node:child_process";
const children = [
  spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "watch", "server/index.ts"],
    { stdio: "inherit" },
  ),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    stdio: "inherit",
  }),
];
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill();
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
for (const child of children) child.on("exit", close);
