# Internal project records

**This folder is not user documentation.** It holds the historical process record from building
Phoenix: work logs, plans, handoff notes, hardware test runbooks and status reports. They are
kept because they explain how the project got where it is and because the evidence in
[`../parity/`](../parity/) refers back to them — not because anyone running Phoenix needs them.

If you are here to run, deploy or understand Phoenix, read the [main README](../../README.md),
the [runbook](../RUNBOOK.md) and the [operations guide](../OPERATIONS.md) instead.

| File | What it is |
|---|---|
| `WORKLOG.md` | The running build log |
| `PARITY.md` | The early parity status and plan, superseded by [`../parity/PLAN.md`](../parity/PLAN.md) |
| `ROADMAP.md` | The atlas-derived feature checklist used during the rebuild |
| `M9-REPORT.md` | The milestone-9 parity report (June 2026), retained as project history |
| `OOBE-PORTAL-HANDOFF.md` | The design brief for the account service and web portal, followed by what was built |
| `HW-OOBE-TEST.md` | The procedure used to take a robot through out-of-box setup against Phoenix |
| `plans/PUBLIC-PHOENIX-AND-OTA-REPOINT.md` | A written-but-unbuilt design for a USB one-shot repoint tool and a self-repointing OTA image |

The per-tool notes for the verification harnesses (`scripts/parity-*/README.md`) stay beside
their tools rather than here, because that is where someone using them looks.
