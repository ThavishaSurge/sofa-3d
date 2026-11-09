# --- build stage: full image has python/make/g++ in case better-sqlite3 must compile ---
FROM node:22 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- runtime ---
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
# Railway: attach a volume mounted at /data (database + uploaded models/textures live there)
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "src/server.js"]
