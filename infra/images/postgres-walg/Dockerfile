# Dev/prod-parity Postgres with the wal-g binary present. WAL archiving is NOT
# enabled here (archive_mode stays off); only the binary is installed.
FROM postgres:18.6

ARG WALG_VERSION=v3.0.9
ARG WALG_ASSET=wal-g-pg-24.04-amd64
ARG WALG_TGZ_SHA256=444ce216230c254edef803e098a59a1746806da3e0d55671d7b0f0082db14ef4

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /tmp/walg.tar.gz \
      "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/${WALG_ASSET}.tar.gz" \
 && echo "${WALG_TGZ_SHA256}  /tmp/walg.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/walg.tar.gz -C /tmp \
 && install -m 0755 "/tmp/${WALG_ASSET}" /usr/local/bin/wal-g \
 && rm -f /tmp/walg.tar.gz "/tmp/${WALG_ASSET}" \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*

HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD pg_isready -U "${POSTGRES_USER:-postgres}" || exit 1
