FROM node:22-alpine

WORKDIR /app

COPY package.json server.js ./
COPY server ./server
COPY public ./public

ENV PORT=3456
EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "server.js"]
