---
"basepad": minor
---

Add `postgresWithNeonProxy()`: basepad's Postgres with Neon's local proxy in front of it, so `@neondatabase/serverless` connects locally through `url` and `wsProxy`, with `directUrl` for every other tool. `status` lists the proxy as `<key>-neon-proxy`; on Linux it needs glibc 2.39 or newer, and `up` says so on an older one.
