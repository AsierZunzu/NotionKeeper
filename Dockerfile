FROM node:26-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

RUN mkdir /downloads && chmod 755 /downloads

# Drops root to PUID:PGID (default 1000:1000) before NotionKeeper starts.
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh", "node", "/app/src/notionKeeper.ts"]
