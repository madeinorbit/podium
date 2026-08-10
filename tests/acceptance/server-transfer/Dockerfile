FROM oven/bun:1.3.14-debian

RUN apt-get update \
  && apt-get install -y --no-install-recommends abduco bash build-essential ca-certificates git procps python3 tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile

ENTRYPOINT ["/usr/bin/tini", "--"]
