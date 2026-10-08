FROM node:24-bookworm-slim AS build
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM build AS production-dependencies
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production GATEWAY_MODE=azure HOST=0.0.0.0 PORT=3001
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/package*.json ./
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=production-dependencies --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=production-dependencies --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=production-dependencies --chown=node:node /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["npm", "run", "start", "-w", "@gateway/api"]
