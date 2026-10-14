# Y11 HQ in one box: the built React screens + the Express server that serves them.
# Railway builds this file. On your Mac: `docker compose up --build` (see docker-compose.yml).

# ---------- Stage 1: install every tool and build ----------
FROM node:24.21-slim AS build
WORKDIR /app

# Package files first, so Docker can reuse the installed packages when only the code changes.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY . .
RUN npm run build

# ---------- Stage 2: the small box that actually runs ----------
FROM node:24.21-slim
ENV NODE_ENV=production
WORKDIR /app

# Only the server's runtime packages: no TypeScript, Vite or test tools.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace=server && npm cache clean --force

# The built code from stage 1. app.ts serves client/dist next to the API.
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist

# Don't run as root inside the box.
USER node
EXPOSE 4000

# Create any missing tables, prices and the CEO login, then start the server.
# Safe on every start: the seed skips anything that already exists.
CMD ["sh", "-c", "node server/dist/db/seed.js && exec node server/dist/index.js"]
