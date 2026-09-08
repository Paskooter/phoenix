#!/usr/bin/env bash
# repoint-robot.sh — RUN THIS ON YOUR PC. Points a Jibo's cloud hostnames at a
# Phoenix instance and installs the Phoenix CA into the robot's REAL, boot
# persistent OpenSSL trust store.
#
# Certificates come from the server, which generates them on its first start.
# This script reads them, and checks that they actually cover the region the
# robot reports - a certificate missing that name is rejected by the robot no
# matter what it trusts, and it is the most common way this setup fails. If the
# names do not match it says exactly what to set on the server, rather than
# reissuing behind the server's back and leaving it serving the old certificate.
#
# On the robot it changes exactly two things, both data (never robot code):
#   1. /etc/hosts  (a symlink to /var/etc/hosts, on the rw /var partition):
#      a managed block mapping <region>.jibo.com and <region>-socket.jibo.com
#      to the Phoenix host for every region you list, so the robot reaches
#      Phoenix no matter which region its system-manager reports.
#   2. The OpenSSL default trust store: the Phoenix CA is written into the real
#      /etc/ssl/certs on the root filesystem, with the subject-hash symlink and
#      an appended ca-certificates.crt entry.
#
# Why the trust store needs care: on a robot already set up by hand,
# /etc/ssl/certs is often a BIND MOUNT over the real directory. Writing through
# the bind looks like it works and is silently lost on reboot. This script
# detects that, writes to the real directory underneath via a temporary rootfs
# bind, and leaves the result boot persistent.
#
# Nothing is changed without showing you a plan first. Every edited file is
# backed up. Re-running is idempotent. --revert undoes it.
#
# Usage:
#   scripts/parity-robot/repoint-robot.sh --robot <host> --phoenix <ip> [options]
#   scripts/parity-robot/repoint-robot.sh --robot <host> --revert
#
# Options:
#   --robot <host>      robot ssh target, e.g. root@moth-....jibo   (required)
#   --phoenix <ip>      Phoenix host IP as seen from the robot      (required to apply)
#   --ca <path>         CA PEM to trust (default: <cert-dir>/ca.crt)
#   --cert-dir <dir>    where certificates live (default: the server's TLS home,
#                       $PHOENIX_TLS_HOME or ~/.local/share/phoenix/tls)
#   --public-name <fqdn>  extra SAN, repeatable — use for internet-facing hostnames
#   --regenerate-cert   reissue the serving certificate even if it already matches
#   --cert-only         discover the region and issue certificates, then stop
#   --regions a,b,c     extra regions to map (the live region is always included)
#   --dry-run           run every check, print the plan, change nothing
#   --yes               skip the confirmation prompt
#   --drop-bind         also unmount a detected /etc/ssl/certs bind after installing
#   --verify            after applying, poll the native notification status
#   --revert            restore the hosts block and remove the Phoenix CA
set -euo pipefail

ROBOT=""; PHOENIX=""; CERT_DIR="${PHOENIX_TLS_HOME:-${XDG_DATA_HOME:-${HOME}/.local/share}/phoenix/tls}"; CA=""
SERVER_CRT=""; SERVER_KEY=""; EXTRA_NAMES=""; REGEN=0
EXTRA_REGIONS="api"; DRY=0; ASSUME_YES=0; DROP_BIND=0; VERIFY=0; REVERT=0; CERT_ONLY=0
MARK_BEGIN="# >>> phoenix-repoint >>>"
MARK_END="# <<< phoenix-repoint <<<"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

while [ $# -gt 0 ]; do
  case "$1" in
    --robot) ROBOT="${2:-}"; shift 2 ;;
    --phoenix) PHOENIX="${2:-}"; shift 2 ;;
    --ca) CA="${2:-}"; shift 2 ;;
    --cert-dir) CERT_DIR="${2:-}"; shift 2 ;;
    --public-name) EXTRA_NAMES="${EXTRA_NAMES}${EXTRA_NAMES:+,}${2:-}"; shift 2 ;;
    --regenerate-cert) REGEN=1; shift ;;
    --cert-only) CERT_ONLY=1; shift ;;
    --regions) EXTRA_REGIONS="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --drop-bind) DROP_BIND=1; shift ;;
    --verify) VERIFY=1; shift ;;
    --revert) REVERT=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$CA" ] || CA="${CERT_DIR}/ca.crt"
CA_KEY="${CERT_DIR}/ca.key"
[ -n "$SERVER_CRT" ] || SERVER_CRT="${CERT_DIR}/server.crt"
[ -n "$SERVER_KEY" ] || SERVER_KEY="${CERT_DIR}/server.key"

say()  { printf '\033[36m[repoint]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m[repoint] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[repoint] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m[repoint] OK:\033[0m %s\n' "$*" >&2; }

[ -n "$ROBOT" ] || die "--robot is required"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$ROBOT")
rsh() { timeout 90 "${SSH[@]}" "$@"; }

# ---------------------------------------------------------------- preflight
say "preflight: connecting to $ROBOT"
rsh true 2>/dev/null || die "cannot ssh to $ROBOT (need key-based access as root)"

ARCH="$(rsh 'uname -m' 2>/dev/null || true)"
HAS_REGISTRY="$(rsh 'curl -s -m 4 -o /dev/null -w "%{http_code}" http://127.0.0.1:8181/registry 2>/dev/null; true' 2>/dev/null)"
[ "$HAS_REGISTRY" = "200" ] || die "no Jibo service registry on 127.0.0.1:8181 (got HTTP $HAS_REGISTRY). Refusing to touch this host."
ok "reachable Jibo ($ARCH), service registry answering"

# /etc/hosts must be the writable /var symlink, not a read-only rootfs file.
HOSTS_TARGET="$(rsh 'readlink -f /etc/hosts' 2>/dev/null || true)"
[ -n "$HOSTS_TARGET" ] || die "cannot resolve /etc/hosts"
rsh "test -w '$HOSTS_TARGET'" 2>/dev/null || die "$HOSTS_TARGET is not writable; this robot stores hosts differently than expected. Stopping rather than guessing."
ok "hosts file: $HOSTS_TARGET (writable)"

# Live region, read-only. Only the region name is printed; credentials are not read out.
SM_PORT="$(rsh "curl -s -m 5 http://127.0.0.1:8181/registry | tr ',' '\n' | grep -A2 'system-manager' | grep port | tr -dc '0-9'" 2>/dev/null || true)"
[ -n "$SM_PORT" ] || SM_PORT=8585
LIVE_REGION="$(rsh "curl -s -m 5 -H 'Authentication: foobar' http://127.0.0.1:${SM_PORT}/credentials | sed -n 's/.*\"region\"[^\"]*\"\\([^\"]*\\)\".*/\\1/p'" 2>/dev/null || true)"
if [ -n "$LIVE_REGION" ]; then ok "live region from system-manager: $LIVE_REGION"
else warn "could not read the live region; falling back to --regions only"; fi

REGIONS="$(printf '%s\n%s\n' "$LIVE_REGION" "$(echo "$EXTRA_REGIONS" | tr ',' '\n')" | sed '/^$/d' | sort -u | tr '\n' ' ')"
[ -n "$(echo "$REGIONS" | tr -d ' ')" ] || die "no regions to map"

# Trust store: is the visible /etc/ssl/certs a bind mount hiding the real one?
BIND_LINE="$(rsh "mount | grep ' /etc/ssl/certs '" 2>/dev/null || true)"
if [ -n "$BIND_LINE" ]; then
  warn "/etc/ssl/certs is a MOUNT, so the visible store is not the persistent one:"
  warn "  $BIND_LINE"
  warn "the CA will be written to the real directory underneath, which survives reboot"
  BIND_PRESENT=1
else
  BIND_PRESENT=0
  ok "/etc/ssl/certs is the real directory (no mount over it)"
fi

if [ "$REVERT" -eq 0 ]; then
  [ -n "$PHOENIX" ] || die "--phoenix <ip> is required to apply (use --revert to undo)"
  # The robot builds its own hostnames, so the certificate it will accept is
  # fully determined by the region we just discovered. Derive the SAN list and
  # issue the certificate here rather than making the operator hand-run openssl
  # and get the names subtly wrong, which is the single most common failure.
  SAN="DNS:localhost"
  for r in $REGIONS; do SAN="${SAN},DNS:${r}.jibo.com,DNS:${r}-socket.jibo.com"; done
  for n in $(echo "$EXTRA_NAMES" | tr ',' ' '); do [ -n "$n" ] && SAN="${SAN},DNS:${n}"; done
  SAN="${SAN},IP:127.0.0.1"
  case "$PHOENIX" in [0-9]*.[0-9]*.[0-9]*.[0-9]*) SAN="${SAN},IP:${PHOENIX}" ;; esac

  mkdir -p -m 700 "$CERT_DIR"

  if [ -r "$CA" ] && [ -r "$SERVER_CRT" ]; then
    ok "using the certificates the server generated in $CERT_DIR"
  elif [ ! -r "$CA" ] || [ ! -r "$CA_KEY" ]; then
    # Normally the server creates these on its first start and we just read
    # them. Generating here is the fallback for a robot-first workflow.
    warn "no certificates in $CERT_DIR - the server normally creates these on startup"
    [ "$DRY" -eq 1 ] && say "would create a CA at $CA" || {
      say "creating a CA at $CA"
      openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "$CA_KEY" -out "$CA" -subj "/CN=Phoenix development CA" 2>/dev/null
      chmod 600 "$CA_KEY" "$CA"
      ok "CA created"
    }
  fi
  [ -r "$CA" ] || { [ "$DRY" -eq 1 ] && say "(dry run: no CA yet, skipping certificate checks)"; }

  if [ -r "$CA" ]; then
    openssl x509 -in "$CA" -noout >/dev/null 2>&1 || die "not a PEM certificate: $CA"
    openssl x509 -in "$CA" -noout -checkend 0 >/dev/null 2>&1 || warn "the CA certificate is expired"

    # Reissue when the serving certificate is missing, expiring, or lacks any
    # name the robot will ask for. A chain that verifies is not enough: the
    # native client also checks the hostname.
    NEED_CERT=0
    if [ "$REGEN" -eq 1 ] || [ ! -r "$SERVER_CRT" ]; then NEED_CERT=1; else
      for n in $(echo "$SAN" | tr ',' '\n' | sed -n 's/^DNS://p'); do
        openssl x509 -in "$SERVER_CRT" -noout -ext subjectAltName 2>/dev/null \
          | grep -q "DNS:${n}\([,[:space:]]\|$\)" || { NEED_CERT=1; break; }
      done
      openssl x509 -in "$SERVER_CRT" -noout -checkend 604800 >/dev/null 2>&1 || NEED_CERT=1
    fi

    if [ "$NEED_CERT" -eq 1 ] && [ -r "$SERVER_CRT" ] && [ "$REGEN" -eq 0 ]; then
      REGION_CSV="$(printf '%s' "$REGIONS" | tr -s ' ' ',' | sed -e 's/^,//' -e 's/,$//')"
      warn "the server certificate does not cover every name this robot needs."
      warn "region ${LIVE_REGION:-unknown} needs: $SAN"
      warn "The server owns this certificate, so fix it there and restart. Otherwise"
      warn "the server keeps serving the old one and the robot still refuses it:"
      warn "  PHOENIX_TLS_REGIONS=${REGION_CSV}"
      warn "Then re-run this script. Pass --regenerate-cert to reissue here instead."
      die "certificate does not cover the region this robot reports"
    fi

    if [ "$NEED_CERT" -eq 1 ] && [ "$DRY" -eq 0 ]; then
      say "issuing a serving certificate for: $SAN"
      [ -r "$SERVER_KEY" ] || { openssl genrsa -out "$SERVER_KEY" 2048 2>/dev/null; chmod 600 "$SERVER_KEY"; }
      [ -r "$SERVER_CRT" ] && cp -p "$SERVER_CRT" "${SERVER_CRT}.phx-bak-${STAMP}"
      openssl req -new -key "$SERVER_KEY" -out "${CERT_DIR}/server.csr" -subj "/CN=localhost" 2>/dev/null
      printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' \
        "$SAN" > "${CERT_DIR}/server.ext"
      openssl x509 -req -in "${CERT_DIR}/server.csr" -CA "$CA" -CAkey "$CA_KEY" -CAcreateserial \
        -days 825 -sha256 -extfile "${CERT_DIR}/server.ext" -out "$SERVER_CRT" 2>/dev/null
      chmod 600 "$SERVER_CRT"
      ok "issued $SERVER_CRT"
      warn "the server must now load this certificate and be restarted:"
      warn "  PHOENIX_ROBOT_TLS_CERT=$SERVER_CRT"
      warn "  PHOENIX_ROBOT_TLS_KEY=$SERVER_KEY"
    elif [ "$NEED_CERT" -eq 1 ]; then
      say "would issue a serving certificate for: $SAN"
    else
      ok "existing certificate already covers every required name"
    fi

    CA_HASH="$(openssl x509 -in "$CA" -noout -subject_hash)"
    CA_FP="$(openssl x509 -in "$CA" -noout -fingerprint -sha256 | cut -d= -f2)"
    CA_SUBJ="$(openssl x509 -in "$CA" -noout -subject | sed 's/^subject=//')"
    ok "CA: $CA_SUBJ"
    ok "CA sha256: $CA_FP"
  fi

  if [ "$CERT_ONLY" -eq 1 ]; then
    say "--cert-only: certificates are ready; the robot was not modified"
    exit 0
  fi

  # Phoenix must actually be reachable from the robot, or we would strand it.
  REACH="$(rsh "curl -s -m 6 -o /dev/null -w '%{http_code}' -k https://${PHOENIX}:443/healthcheck 2>/dev/null; true" 2>/dev/null)"
  if [ "$REACH" = "000" ]; then
    warn "robot could not reach https://${PHOENIX}:443 — the robot will not connect until Phoenix listens there"
  else
    ok "robot reached https://${PHOENIX}:443 (HTTP $REACH)"
  fi

  # The decisive check: the CA we are about to install into the robot must
  # actually verify what the server is serving right now, under the hostname the
  # robot will use. This catches the case where the server was configured with a
  # different certificate directory than the one we are reading, which would
  # otherwise install trust for a CA the server never uses and leave the robot
  # rejecting it for reasons that look like anything but this.
  for r in $REGIONS; do
    CHAIN_OK="$(echo | openssl s_client -connect "${PHOENIX}:443" -servername "${r}.jibo.com" \
      -verify_hostname "${r}.jibo.com" -CAfile "$CA" 2>/dev/null | grep -c 'Verify return code: 0 (ok)' || true)"
    if [ "${CHAIN_OK:-0}" -gt 0 ]; then
      ok "the server presents a certificate this CA verifies for ${r}.jibo.com"
    else
      warn "the certificate the server is serving is NOT verified by $CA for ${r}.jibo.com."
      warn "Installing this CA would not make the robot trust that server."
      warn "Point the server at these files and restart it:"
      warn "  PHOENIX_ROBOT_TLS_CERT=$SERVER_CRT"
      warn "  PHOENIX_ROBOT_TLS_KEY=$SERVER_KEY"
      warn "or re-run with --cert-dir set to whatever the server actually loads."
      die "the CA does not verify the running server for ${r}.jibo.com"
    fi
  done
fi

# ---------------------------------------------------------------- plan
echo
say "PLAN for $ROBOT"
if [ "$REVERT" -eq 1 ]; then
  echo "  - remove the managed hosts block from $HOSTS_TARGET (restores prior lines)"
  echo "  - remove the Phoenix CA from the real /etc/ssl/certs and its hash symlink"
else
  echo "  - hosts file: $HOSTS_TARGET"
  for r in $REGIONS; do
    printf '      %-15s -> %s\n' "${r}.jibo.com" "$PHOENIX"
    printf '      %-15s -> %s\n' "${r}-socket.jibo.com" "$PHOENIX"
  done
  echo "  - install CA into the real /etc/ssl/certs as phoenix-ca.crt + ${CA_HASH:-<hash of the CA to be created>}.0"
  echo "  - append it to ca-certificates.crt (backed up first)"
  [ "$BIND_PRESENT" -eq 1 ] && [ "$DROP_BIND" -eq 1 ] && echo "  - unmount the /etc/ssl/certs bind afterwards"
  [ "$BIND_PRESENT" -eq 1 ] && [ "$DROP_BIND" -eq 0 ] && echo "  - LEAVE the existing bind mounted (pass --drop-bind to remove it)"
fi
echo "  - every edited file is backed up with suffix .phx-bak-$STAMP"
echo

if [ "$DRY" -eq 1 ]; then say "--dry-run: nothing was changed"; exit 0; fi
if [ "$ASSUME_YES" -eq 0 ]; then
  printf 'Proceed? [y/N] ' >&2; read -r reply </dev/tty
  case "$reply" in y|Y|yes|YES) ;; *) say "aborted; nothing changed"; exit 1 ;; esac
fi

# ---------------------------------------------------------------- apply
if [ "$REVERT" -eq 1 ]; then
  say "reverting hosts block"
  rsh "cp -p '$HOSTS_TARGET' '${HOSTS_TARGET}.phx-bak-${STAMP}' && sed -i '/${MARK_BEGIN}/,/${MARK_END}/d' '$HOSTS_TARGET'"
  ok "hosts block removed (backup ${HOSTS_TARGET}.phx-bak-${STAMP})"
  say "removing Phoenix CA from the real trust store"
  rsh "set -e
    jibo-mount --rw >/dev/null 2>&1 || mount -o remount,rw / 2>/dev/null || true
    mkdir -p /tmp/.phoenix-rootfs && mount --bind / /tmp/.phoenix-rootfs
    R=/tmp/.phoenix-rootfs/etc/ssl/certs
    rm -f \$R/phoenix-ca.crt \$R/*.0.phoenix 2>/dev/null || true
    for l in \$R/*.0; do [ -L \"\$l\" ] && [ \"\$(readlink \$l)\" = phoenix-ca.crt ] && rm -f \$l; done 2>/dev/null || true
    [ -f \$R/ca-certificates.crt.phx-orig ] && mv -f \$R/ca-certificates.crt.phx-orig \$R/ca-certificates.crt
    sync; umount /tmp/.phoenix-rootfs; rmdir /tmp/.phoenix-rootfs
    mount -o remount,ro / 2>/dev/null || true"
  ok "revert complete"
  exit 0
fi

say "writing hosts block"
HOSTS_BLOCK="$MARK_BEGIN"$'\n'"# written $STAMP by repoint-robot.sh -> Phoenix $PHOENIX"$'\n'
for r in $REGIONS; do
  HOSTS_BLOCK="${HOSTS_BLOCK}${PHOENIX} ${r}.jibo.com"$'\n'"${PHOENIX} ${r}-socket.jibo.com"$'\n'
done
HOSTS_BLOCK="${HOSTS_BLOCK}${MARK_END}"

# Back up once, strip any previous managed block, comment out conflicting prior
# entries for the same names, then append the new block. The supersede rules are
# generated here and piped as a sed script: building them inline over ssh needs
# several layers of quoting and silently fails to match.
SEDSCRIPT=""
for r in $REGIONS; do
  for n in "${r}.jibo.com" "${r}-socket.jibo.com"; do
    esc="$(printf '%s' "$n" | sed 's/\./\\./g')"
    SEDSCRIPT="${SEDSCRIPT}s|^\\([^#].*[[:space:]]${esc}[[:space:]]*\\)$|# superseded by phoenix-repoint: \\1|
"
  done
done

printf '%s' "$SEDSCRIPT" | rsh "cat > /tmp/.phoenix-hosts-sed"
printf '%s\n' "$HOSTS_BLOCK" | rsh "cat > /tmp/.phoenix-hosts-block"
rsh "set -e
  cp -p '$HOSTS_TARGET' '${HOSTS_TARGET}.phx-bak-${STAMP}'
  sed -i '/${MARK_BEGIN}/,/${MARK_END}/d' '$HOSTS_TARGET'
  sed -i -f /tmp/.phoenix-hosts-sed '$HOSTS_TARGET'
  cat /tmp/.phoenix-hosts-block >> '$HOSTS_TARGET'
  rm -f /tmp/.phoenix-hosts-sed /tmp/.phoenix-hosts-block"
ok "hosts updated (backup ${HOSTS_TARGET}.phx-bak-${STAMP})"

[ -n "${CA_HASH:-}" ] || die "no CA hash: the CA was not created or read"
say "installing CA into the real (persistent) trust store"
rsh "cat > /tmp/.phoenix-ca.crt" < "$CA"
rsh "set -e
  jibo-mount --rw >/dev/null 2>&1 || mount -o remount,rw / 2>/dev/null || true
  mkdir -p /tmp/.phoenix-rootfs && mount --bind / /tmp/.phoenix-rootfs
  R=/tmp/.phoenix-rootfs/etc/ssl/certs
  [ -d \$R ] || { echo 'real /etc/ssl/certs missing'; exit 1; }
  cp /tmp/.phoenix-ca.crt \$R/phoenix-ca.crt
  chmod 644 \$R/phoenix-ca.crt
  ln -sf phoenix-ca.crt \$R/${CA_HASH}.0
  if [ -f \$R/ca-certificates.crt ]; then
    [ -f \$R/ca-certificates.crt.phx-orig ] || cp -p \$R/ca-certificates.crt \$R/ca-certificates.crt.phx-orig
    grep -q \"\$(head -2 /tmp/.phoenix-ca.crt | tail -1)\" \$R/ca-certificates.crt || cat /tmp/.phoenix-ca.crt >> \$R/ca-certificates.crt
  fi
  sync
  umount /tmp/.phoenix-rootfs; rmdir /tmp/.phoenix-rootfs
  mount -o remount,ro / 2>/dev/null || true
  rm -f /tmp/.phoenix-ca.crt"
ok "CA installed persistently as phoenix-ca.crt + ${CA_HASH}.0"

if [ "$BIND_PRESENT" -eq 1 ] && [ "$DROP_BIND" -eq 1 ]; then
  say "unmounting the /etc/ssl/certs bind"
  rsh "umount /etc/ssl/certs" && ok "bind removed; the persistent store is now in use" || warn "could not unmount the bind (busy?); it remains"
fi

# ---------------------------------------------------------------- verify
say "verifying"
# busybox has no getent; resolve via ping, which uses the libc resolver and
# therefore honours /etc/hosts, and cross-check the file itself.
resolved() { rsh "ping -c1 -W1 '$1' 2>&1 | head -1 | sed -n 's/^[^(]*(\\([0-9.]*\\)).*/\\1/p'" 2>/dev/null || true; }
for r in $REGIONS; do
  for n in "${r}.jibo.com" "${r}-socket.jibo.com"; do
    INFILE="$(rsh "grep -c '^[^#].*[[:space:]]${n}\$' '$HOSTS_TARGET'" 2>/dev/null || echo 0)"
    GOT="$(resolved "$n")"
    if [ "$GOT" = "$PHOENIX" ]; then ok "$n -> $GOT"
    elif [ "${INFILE:-0}" -gt 0 ]; then warn "$n is in $HOSTS_TARGET but resolved to '${GOT:-nothing}'"
    else warn "$n missing from $HOSTS_TARGET and resolved to '${GOT:-nothing}'"; fi
  done
done
rsh "test -f /etc/ssl/certs/phoenix-ca.crt" 2>/dev/null \
  && ok "CA visible in the active store" \
  || warn "CA not visible in the ACTIVE store — a bind mount may still be masking it (see --drop-bind)"

if [ "$VERIFY" -eq 1 ]; then
  say "polling the native notification status (0=invalid 1=connected 2=disconnected)"
  warn "this is the only real proof; a Node or curl TLS probe does NOT test the native OpenSSL path"
  rsh "curl -s -m 8 http://127.0.0.1:8888/server/notifications/status 2>/dev/null | head -c 300" || true
  echo
fi

say "done. The native client retries every 15s, so allow ~30s before judging status."
say "A reboot is the real test of persistence: the hosts file and trust store should both survive."
