FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

# 진입점은 main.js. CLUSTER_WORKERS=1 이면 단일 프로세스, 2 이상이면 클러스터.
CMD ["node", "src/main.js"]
