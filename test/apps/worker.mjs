// A worker for the tests: listens on nothing, records the PORT it was given (none, it should be)
// in `worker.json` in its folder, and runs until stopped.
import { writeFileSync } from "node:fs";

writeFileSync("worker.json", JSON.stringify({ port: process.env.PORT ?? null, pid: process.pid }));
console.log("working");
setInterval(() => {}, 1 << 30);
