# ---- Build stage -------------------------------------------------------
# devDependencies (typescript) が必要なため npm ci を --omit=dev なしで実行
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Runtime stage -----------------------------------------------------
# dist/ だけをコピーし、prod deps のみインストールして軽量化
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 8082
CMD ["node", "dist/server.js"]
