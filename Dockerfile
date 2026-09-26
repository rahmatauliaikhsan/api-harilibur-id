# api-harilibur-id — image tanpa dependensi eksternal
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    AUTO_REFRESH=true \
    REFERENCE_TIMEZONE=Asia/Jakarta

WORKDIR /app

# Hanya berkas yang diperlukan (tanpa node_modules karena zero-dependency)
COPY package.json ./
COPY src ./src
COPY data/skb ./data/skb

RUN mkdir -p /app/data/cache && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
