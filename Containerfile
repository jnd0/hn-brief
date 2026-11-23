FROM docker.io/oven/bun:1.3.14-alpine

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY shared ./shared
COPY scripts ./scripts
COPY tsconfig.json ./

ENV DATA_DIR=/data \
    TZ=America/New_York

VOLUME ["/data"]
ENTRYPOINT ["bun", "run", "pipeline", "--"]
CMD ["generate"]
