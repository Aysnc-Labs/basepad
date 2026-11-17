import { writeFileSync } from "node:fs";

writeFileSync("worker.json", JSON.stringify({ port: process.env.PORT ?? null, pid: process.pid }));
console.log("working");
setInterval(() => {}, 1 << 30);
