FROM oven/bun:1.3.14-debian

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash build-essential ca-certificates git procps python3 tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY . .
RUN chmod 0755 tests/acceptance/server-transfer/fake-codex.sh \
  && ln -s /workspace/tests/acceptance/server-transfer/fake-codex.sh /usr/local/bin/codex
RUN bun install --frozen-lockfile

ENTRYPOINT ["/usr/bin/tini", "--"]
