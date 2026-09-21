FROM node:26.9.0-alpine3.23@sha256:9dac39bfd053b458593c44a099d2667994c8fa9e1a8c10bc7ff2f3d97b62412d AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:26.9.0-alpine3.23@sha256:9dac39bfd053b458593c44a099d2667994c8fa9e1a8c10bc7ff2f3d97b62412d AS runtime
ENV NODE_ENV=production
ENV BIND_HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.SERVER_PORT ?? 4173}/api/health`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
USER node
CMD ["node", "dist-server/server/start-server.js"]
