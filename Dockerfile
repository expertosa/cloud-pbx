# Cloud PBX — API server + dashboard
FROM node:22-slim AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM node:22-slim AS server
WORKDIR /src/server
COPY server/package*.json ./
RUN npm ci
COPY server ./
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends sox libsox-fmt-all ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY --from=server /src/server/dist ./dist
COPY --from=server /src/server/node_modules ./node_modules
COPY --from=server /src/server/package.json ./
COPY server/migrations ./migrations
COPY --from=web /src/web/dist /app/web/dist
COPY prompts /opt/cloudpbx/prompts
ENV WEB_DIST_DIR=/app/web/dist PROMPTS_DIR=/opt/cloudpbx/prompts SOUNDS_DIR=/data/sounds RECORDINGS_DIR=/var/spool/asterisk/recording PORT=3000
EXPOSE 3000
CMD ["node", "dist/index.js"]
