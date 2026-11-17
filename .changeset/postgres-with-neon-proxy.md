---
"basepad": minor
---

Add `postgresWithNeonProxy()`: basepad's Postgres with Neon's local proxy in front of it, so `@neondatabase/serverless` connects locally through `url` and `wsProxy`, with `directUrl` for every other tool. `status` and mission control list the proxy as `<key>-neon-proxy`, and stopping or starting the service stops or starts its proxy too; `up` and `prune` stop a proxy the config no longer asks for. On Linux it needs glibc 2.39 or newer, and `up` says so on an older one.
