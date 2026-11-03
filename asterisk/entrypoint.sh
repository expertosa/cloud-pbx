#!/usr/bin/env bash
set -euo pipefail
export AST_ETC_DIR=/etc/asterisk AST_RUN_USER=asterisk
bash /opt/cloudpbx/asterisk/render-config.sh
mkdir -p /var/spool/asterisk/recording /var/lib/asterisk /var/log/asterisk /var/run/asterisk /data/sounds
chown -R asterisk:asterisk /etc/asterisk /var/spool/asterisk /var/lib/asterisk /var/log/asterisk /var/run/asterisk
# Recordings are read by the API container too.
chmod 755 /var/spool/asterisk/recording
exec asterisk -f -U asterisk -G asterisk -vvv
