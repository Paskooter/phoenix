# Account snapshot permissions and restart review

Root accepted `1f4cf28c18bb4b8dd4e4f1e0cd12bdcd7238dd5e` after reproducing and repairing a restart failure. Under umask `0002`, an Account save replaced a private credential file with mode `0664`; the imported authenticated launcher then rejected the store on restart. The command-line launcher already sets umask `0077` and is separately qualified.

Account now writes an exclusive temporary file with mode `0600`, then replaces the snapshot atomically. Newly created parent directories use `0700`. It cleans only its own temporary file after a failed write or rename. General Account mutation transactions and cross-process coordination remain separate work.

Root exercised real Phoenix services with synthetic credentials: signed TLS CreateHubToken, an Account suspension that saves state, launcher shutdown/restart, and the old token accepted on both Hub paths after restart. Four umask controls, reload, serialization failure, real rename failure and recovery pass. The final frozen suite passes **720 units, seven skips, and strict43 with zero differences, invariants or gaps**. Earlier container dependency-link setup failures remain recorded in the [review](../evidence/2026-09-07/account-store-permissions/review.json).

Full H-10, persistent authenticated Moth deployment, and microphone/ring acceptance remain open. No new robot test is claimed.
