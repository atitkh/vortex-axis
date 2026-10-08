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

# Runtime stage: production dependencies and compiled output only.
FROM node:24-alpine
ENV NODE_ENV=production \
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
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8440
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8440/healthz || exit 1
CMD ["node", "server/dist/index.js"]
