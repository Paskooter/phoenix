# A-05 — issued credentials survive a robot restart

Date: 2026-09-15
Robot: Moth (192.168.1.217)
Status: **one A-05 acceptance clause discharged.** A-05 as a whole remains
`todo` pending the out-of-box pairing work.

## The clause

> "Compare SDK request/response and QR payload framing with original consumers;
> **preserve issued credentials across service/robot restart.**"

The *service* restart half was already accepted (38 initial and 46 post-restart
SDK checks). The **robot** restart half needed real hardware and is discharged
here.

## Witness

Two facts, each independently checkable, and neither satisfiable by accident:

| | before | after |
| --- | --- | --- |
| `/proc/sys/kernel/random/boot_id` | `e6dedbec-a0ff-4355-ac43-052883986a26` | `0c0610c0-bcdc-4437-8231-e18c5f52ff12` |
| `sha256(/var/jibo/credentials.json)` | `2c8fdf39…2cb654` | `2c8fdf39…2cb654` |
| credential keys | `accessKeyId, region, secretAccessKey` | same |
| uptime (s) | 178439.88 | 62.00 |

**A differing boot id proves the robot really restarted. An identical credential
digest proves the issued credentials survived it.** Verdict: **PASS**.

No secret value was read or copied — only the digest and the key names.

## The first attempt did not reboot, and the witness caught it

`nohup sh -c 'sleep 2; reboot'` returned success and changed nothing: the boot
id was unchanged and uptime had advanced by 12 seconds. busybox `reboot`
signals init, and init ignored it.

Had the witness been "the robot answered SSH again afterwards", this would have
been recorded as a pass. It is worth stating plainly: **the control worked, and
the convenient-looking result was false.** The reboot was then forced with
`sync; sync; /sbin/reboot -f`, after which SSH dropped and the robot came back
with a new boot id.

## Post-restart state

The deployed slot `/opt/jibo/Jibo/Skills/phoenix-be-11-0-1-parity` is intact and
native services are running. The BE parity slot process is **not** running,
which is its normal state — it is launched on demand by the skills service
rather than at boot, exactly as it was before the restart.

## Reproduction

```bash
ssh root@192.168.1.217 "cat /proc/sys/kernel/random/boot_id; \
  sha256sum /var/jibo/credentials.json; cut -d' ' -f1 /proc/uptime"
ssh root@192.168.1.217 "sync; sync; nohup /sbin/reboot -f >/dev/null 2>&1 &"
# wait for SSH, then repeat the first command
```

Raw before/after records are private at
`~/.local/share/phoenix/a05-restart/`.
