FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

# 단일 프로세스. 클러스터링 없음 (Phase 01 의 핵심 제약).
CMD ["node", "src/server.js"]
