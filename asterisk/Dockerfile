FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends asterisk asterisk-modules gettext-base sox ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /usr/share/cloudpbx/asterisk-stock \
 && for f in indications musiconhold codecs features ccss stasis; do cp /etc/asterisk/$f.conf /usr/share/cloudpbx/asterisk-stock/ || true; done \
 && rm -rf /etc/asterisk/*
COPY asterisk/etc /opt/cloudpbx/asterisk/etc
COPY asterisk/render-config.sh /opt/cloudpbx/asterisk/render-config.sh
COPY asterisk/entrypoint.sh /entrypoint.sh
COPY prompts /opt/cloudpbx/prompts
RUN chmod +x /entrypoint.sh /opt/cloudpbx/asterisk/render-config.sh
EXPOSE 5060/udp 5060/tcp 8088/tcp 10000-20000/udp
ENTRYPOINT ["/entrypoint.sh"]
