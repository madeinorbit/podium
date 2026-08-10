FROM oven/bun:1.3.14-debian

RUN apt-get update \
  && apt-get install -y --no-install-recommends abduco bash ca-certificates git procps tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts

ENTRYPOINT ["/usr/bin/tini", "--"]
