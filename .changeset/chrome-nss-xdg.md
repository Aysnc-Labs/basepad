---
"basepad": patch
---

On Linux, `basepad setup` trusts basepad's CA in Chrome's NSS store at `~/.local/share/pki/nssdb`, where Chrome 146 and later keep it when there is no `~/.pki/nssdb`.
