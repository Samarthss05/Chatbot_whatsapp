import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files = ["src", "scripts", "test", "public"].flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => `${dir}/${f}`),
);
for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
