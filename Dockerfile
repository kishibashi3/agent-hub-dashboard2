FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc
EXPOSE 8080
CMD ["node", "dist/server.js"]
