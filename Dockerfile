# agent-hub-dashboard2 — TypeScript + SSE realtime dashboard
# Multi-stage build: compile TypeScript → minimal production image

# ── Build stage ────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production stage ───────────────────────────────────────────
FROM node:20-slim AS production
WORKDIR /app

# only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# /app/data is expected to be a read-only volume mount (agent-hub app.db)
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=8080 \
    AGENT_HUB_DB_PATH=/app/data/app.db

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health',r=>{process.exit(r.statusCode===200?0:1)})"

CMD ["node", "dist/server.js"]
