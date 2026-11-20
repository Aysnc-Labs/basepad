---
"basepad": minor
---

Run hooks around the `db` commands: `beforeSave`/`afterSave`, `beforeLoad`/`afterLoad`, `beforeDelete`/`afterDelete` (`db rm`), `beforeImport`/`afterImport` and `beforeExport`/`afterExport`, with `BASEPAD_SERVICE` and the command's `BASEPAD_LABEL`, `BASEPAD_SOURCE` or `BASEPAD_FILE`. A `before…` hook runs only once the command is checked (and, for `import`, confirmed), and cancels it if it fails; a failed `after…` hook exits 1 and keeps the work. With `db export` to standard output, hook output goes to standard error.
