#!/usr/bin/env bash
# Renders the Asterisk config templates in asterisk/etc into $AST_ETC_DIR,
# filling in values from the environment. Used by the Docker entrypoint
# and by the local test harness.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/etc" && pwd)"
: "${AST_ETC_DIR:=/etc/asterisk}"
: "${AST_DB_DIR:=/var/lib/asterisk}"
: "${AST_SPOOL_DIR:=/var/spool/asterisk}"
: "${AST_RUN_DIR:=/var/run/asterisk}"
: "${AST_LOG_DIR:=/var/log/asterisk}"
: "${AST_RUN_USER:=asterisk}"
: "${ASTERISK_HTTP_BIND:=0.0.0.0}"
: "${ARI_USER:=cloudpbx}"
: "${ARI_PASSWORD:?ARI_PASSWORD is required}"
: "${SIP_PORT:=5060}"
: "${RTP_START:=10000}"
: "${RTP_END:=20000}"
: "${STUN_ADDR:=stun.l.google.com:19302}"
: "${TRUNK_MODE:=registration}"          # registration | ip | none
: "${TELNYX_SIP_HOST:=sip.telnyx.com}"
: "${TELNYX_CODECS:=ulaw,alaw}"
: "${TEST_TRUNK:=0}"

# EXTERNAL_IP: public IP of this server. Auto-detect is avoided on purpose
# (no outbound HTTP from inside the container); set it explicitly.
if [[ -z "${EXTERNAL_IP:-}" ]]; then
  EXTERNAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "render-config: EXTERNAL_IP not set, using ${EXTERNAL_IP}" >&2
fi

LOCAL_NET_LINES=""
IFS=',' read -ra NETS <<< "${LOCAL_NETS:-10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8}"
for n in "${NETS[@]}"; do
  [[ -n "$n" ]] && LOCAL_NET_LINES+="local_net = ${n}"$'\n'
done

export AST_ETC_DIR AST_DB_DIR AST_SPOOL_DIR AST_RUN_DIR AST_LOG_DIR AST_RUN_USER \
  ASTERISK_HTTP_BIND ARI_USER ARI_PASSWORD SIP_PORT RTP_START RTP_END STUN_ADDR \
  EXTERNAL_IP LOCAL_NET_LINES

mkdir -p "$AST_ETC_DIR"
VARS='${AST_ETC_DIR} ${AST_DB_DIR} ${AST_SPOOL_DIR} ${AST_RUN_DIR} ${AST_LOG_DIR} ${AST_RUN_USER} ${ASTERISK_HTTP_BIND} ${ARI_USER} ${ARI_PASSWORD} ${SIP_PORT} ${RTP_START} ${RTP_END} ${STUN_ADDR} ${EXTERNAL_IP} ${LOCAL_NET_LINES}'
for f in "$SRC_DIR"/*.conf; do
  envsubst "$VARS" < "$f" > "$AST_ETC_DIR/$(basename "$f")"
done

# Stock files Asterisk expects but we do not customise.
STOCK_DIR="${AST_STOCK_DIR:-/usr/share/cloudpbx/asterisk-stock}"
for f in indications.conf musiconhold.conf codecs.conf features.conf ccss.conf stasis.conf; do
  if [[ ! -f "$AST_ETC_DIR/$f" && -f "$STOCK_DIR/$f" ]]; then
    cp "$STOCK_DIR/$f" "$AST_ETC_DIR/$f"
  fi
done
for f in udptl.conf acl.conf geolocation.conf pjproject.conf pjsip_wizard.conf pjsip_notify.conf res_parking.conf confbridge.conf cli_aliases.conf amd.conf res_stun_monitor.conf; do
  [[ -f "$AST_ETC_DIR/$f" ]] || : > "$AST_ETC_DIR/$f"
done
[[ -f "$AST_ETC_DIR/cdr.conf" ]] || printf '[general]\nenable=no\n' > "$AST_ETC_DIR/cdr.conf"
[[ -f "$AST_ETC_DIR/cel.conf" ]] || printf '[general]\nenable=no\n' > "$AST_ETC_DIR/cel.conf"

# ---- Carrier trunk ---------------------------------------------------
TRUNK="$AST_ETC_DIR/pjsip_trunk.conf"
: > "$TRUNK"

if [[ "$TRUNK_MODE" != "none" ]]; then
  cat >> "$TRUNK" <<EOF
[telnyx]
type = endpoint
context = from-trunk
disallow = all
allow = ${TELNYX_CODECS}
aors = telnyx
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
dtmf_mode = rfc4733
trust_id_inbound = yes
send_pai = yes
from_domain = ${TELNYX_SIP_HOST}
EOF
  if [[ "$TRUNK_MODE" == "registration" ]]; then
    : "${TELNYX_SIP_USER:?TELNYX_SIP_USER is required for TRUNK_MODE=registration}"
    : "${TELNYX_SIP_PASSWORD:?TELNYX_SIP_PASSWORD is required for TRUNK_MODE=registration}"
    cat >> "$TRUNK" <<EOF
outbound_auth = telnyx-auth
from_user = ${TELNYX_SIP_USER}

[telnyx-auth]
type = auth
auth_type = userpass
username = ${TELNYX_SIP_USER}
password = ${TELNYX_SIP_PASSWORD}

[telnyx-reg]
type = registration
transport = transport-udp
outbound_auth = telnyx-auth
server_uri = sip:${TELNYX_SIP_HOST}
client_uri = sip:${TELNYX_SIP_USER}@${TELNYX_SIP_HOST}
contact_user = ${TELNYX_SIP_USER}
retry_interval = 60
forbidden_retry_interval = 300
expiration = 600
line = yes
endpoint = telnyx
EOF
  fi
  cat >> "$TRUNK" <<EOF

[telnyx]
type = aor
contact = sip:${TELNYX_SIP_HOST}
qualify_frequency = 60
EOF
  # IP-auth connections: Telnyx signalling addresses to accept calls from.
  if [[ -n "${TELNYX_SIGNALING_IPS:-}" ]]; then
    printf '\n[telnyx-identify]\ntype = identify\nendpoint = telnyx\n' >> "$TRUNK"
    IFS=',' read -ra IPS <<< "$TELNYX_SIGNALING_IPS"
    for ip in "${IPS[@]}"; do [[ -n "$ip" ]] && echo "match = ${ip}" >> "$TRUNK"; done
  fi
fi

# ---- Local test harness ----------------------------------------------
# testtrunk: username + password, for injecting inbound calls.
# sim-carrier: where outbound test calls are sent. It also accepts inbound,
# but only from its own address (identify_by=ip). Matching it by the name
# "sim-carrier" in From would let anyone who can reach SIP — including the
# public /ws path, which Asterisk sees as 127.0.0.1 — place trunk calls.
# The default match is host:port from SIM_CARRIER_URI (127.0.0.1:5090), not
# all of 127.0.0.1, because nginx proxies /ws from 127.0.0.1 on an ephemeral
# port. Set TEST_TRUNK_MATCH (comma-separated) to override. Do not set it to
# a bare 127.0.0.1 on a server that serves the browser phone.
if [[ "$TEST_TRUNK" == "1" ]]; then
  : "${TEST_TRUNK_PASSWORD:=testtrunk-secret}"
  : "${SIM_CARRIER_URI:=sip:carrier@127.0.0.1:5090}"
  if [[ -z "${TEST_TRUNK_MATCH:-}" ]]; then
    carrier="${SIM_CARRIER_URI#*@}"
    carrier="${carrier%%;*}"
    carrier="${carrier%%/*}"
    TEST_TRUNK_MATCH="$carrier"
    if [[ "$TEST_TRUNK_MATCH" == "127.0.0.1" || "$TEST_TRUNK_MATCH" == "::1" || "$TEST_TRUNK_MATCH" == "[::1]" ]]; then
      TEST_TRUNK_MATCH="${TEST_TRUNK_MATCH}:5090"
    fi
  fi
  MATCH_LINES=""
  # Newlines are not separators: a value like "10.0.0.1\nmatch = ..." must not
  # be written into the config. Split on commas only, then require an IP.
  IFS=',' read -ra MATCHES <<< "${TEST_TRUNK_MATCH//$'\n'/}"
  for m in "${MATCHES[@]}"; do
    m="${m// /}"
    [[ -z "$m" ]] && continue
    if [[ ! "$m" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(:[0-9]{1,5})?(/[0-9]{1,3})?$ && ! "$m" =~ ^\[[0-9A-Fa-f:.]+\](:[0-9]{1,5})?$ ]]; then
      echo "render-config: ignoring unsafe TEST_TRUNK_MATCH entry" >&2
      continue
    fi
    MATCH_LINES+="match = ${m}"$'\n'
  done
  cat >> "$TRUNK" <<EOF

[testtrunk]
type = endpoint
context = from-trunk
disallow = all
allow = ulaw,alaw
auth = testtrunk-auth
aors = testtrunk
direct_media = no
rtp_symmetric = yes
dtmf_mode = rfc4733

[testtrunk-auth]
type = auth
auth_type = userpass
username = testtrunk
password = ${TEST_TRUNK_PASSWORD}

[testtrunk]
type = aor
max_contacts = 1

[sim-carrier]
type = endpoint
context = from-trunk
disallow = all
allow = ulaw,alaw
aors = sim-carrier
identify_by = ip
direct_media = no
dtmf_mode = rfc4733

[sim-carrier]
type = aor
contact = ${SIM_CARRIER_URI}

[sim-carrier-identify]
type = identify
endpoint = sim-carrier
${MATCH_LINES}
EOF
fi

echo "render-config: wrote Asterisk config to $AST_ETC_DIR (trunk mode: $TRUNK_MODE, test trunk: $TEST_TRUNK)" >&2
