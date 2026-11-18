---
"basepad": patch
---

As root on Linux, basepads that start Postgres at the same moment no longer fail with `initdb: could not look up effective user ID … user does not exist`: the `basepad` system user is now created under a lock.
