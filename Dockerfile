# Build stage: compile the protocol and the server.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY protocol/package.json protocol/
COPY server/package.json server/
RUN npm ci
COPY protocol protocol
COPY server server
RUN npm run build
# The flasher page's installer (ESP Web Tools), fetched from npm so the page needs nothing from anywhere else.
COPY scripts/fetch-esp-web-tools.mjs scripts/
RUN node scripts/fetch-esp-web-tools.mjs /app/esp-web-tools

# Runtime stage: production dependencies and compiled output only.
FROM node:24-alpine
# Which commit this was built from, shown beside the version. Set by `npm run deploy` and the release workflow.
ARG AXIS_COMMIT=""
LABEL org.opencontainers.image.title="VorteX Axis" \
      org.opencontainers.image.description="A device gateway for AI agents: one agent, reachable from every device around you." \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    AXIS_COMMIT=$AXIS_COMMIT \
    AXIS_HOST=0.0.0.0 \
    AXIS_PORT=8440 \
    AXIS_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
COPY protocol/package.json protocol/
COPY server/package.json server/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/protocol/dist protocol/dist
COPY --from=build /app/server/dist server/dist
COPY web web
# The page that puts firmware on a new board over USB, served at /flash.
COPY flasher/index.html flasher/flash.js flasher/
COPY --from=build /app/esp-web-tools flasher/esp-web-tools
# Board firmware and the Windows desktop app, when this is a release image (empty otherwise): a fresh hub
# can update boards and offer the app from the start (server/src/bundled.ts, desktopapp.ts).
COPY bundled bundled
RUN mkdir -p /data /backup && chown node:node /data /backup
USER node
VOLUME /data
EXPOSE 8440
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8440/healthz || exit 1
CMD ["node", "server/dist/index.js"]
