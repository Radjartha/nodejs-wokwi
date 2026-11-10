FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=8067

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY db ./db
COPY public ./public

USER node
EXPOSE 8067

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8067/api/health >/dev/null || exit 1

CMD ["node", "src/server.js"]
