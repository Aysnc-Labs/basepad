---
"basepad": minor
---

`basepad up` and `prune` stop a `postgresWithNeonProxy()` proxy the config no longer asks for, once its service is switched back to `postgres()` or removed. Mission control shows the proxy as its own part and follows its logs, and stopping or starting the service stops or starts its proxy too.
