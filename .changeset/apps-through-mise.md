---
"basepad": minor
---

Apps run through mise in their checkout, so `php artisan serve` uses the PHP your `mise.toml` pins even when Homebrew's comes first on `PATH`, and an app in a worktree uses the worktree's tools.
