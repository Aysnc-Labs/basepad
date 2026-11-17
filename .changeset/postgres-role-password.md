---
"basepad": patch
---

The `postgres` role of every Postgres service now has the password `basepad`, stored as SCRAM, so the password in `url` is real. Local connections still need none; an existing server gets it on its next `basepad up`.
