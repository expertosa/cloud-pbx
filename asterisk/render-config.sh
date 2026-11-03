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
# A username-authenticated "carrier" for injecting inbound calls, and a
# simulated carrier endpoint that outbound calls are sent to.
if [[ "$TEST_TRUNK" == "1" ]]; then
  : "${TEST_TRUNK_PASSWORD:=testtrunk-secret}"
  : "${SIM_CARRIER_URI:=sip:carrier@127.0.0.1:5090}"
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
direct_media = no
dtmf_mode = rfc4733

[sim-carrier]
type = aor
contact = ${SIM_CARRIER_URI}
EOF
fi

echo "render-config: wrote Asterisk config to $AST_ETC_DIR (trunk mode: $TRUNK_MODE, test trunk: $TEST_TRUNK)" >&2
