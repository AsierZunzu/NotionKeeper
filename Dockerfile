FROM node:26-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

RUN mkdir /downloads && chmod 755 /downloads

ENTRYPOINT ["node", "/app/src/notionKeeper.ts"]
