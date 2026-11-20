---
"basepad": minor
---

Apps run through mise in their checkout, so `php artisan serve` uses the PHP your `mise.toml` pins even when Homebrew's comes first on `PATH`, and an app in a worktree uses the worktree's tools. Before any hook or app runs, `basepad up` checks that mise trusts the checkout's config, even in a project with no services: an untrusted `mise.toml` fails with mise's error and the `mise trust` command, and basepad never trusts it for you.
