FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY examples/http-server.ts ./examples/http-server.ts

RUN npm ci && npm run build

ENV HOST=0.0.0.0
ENV PORT=8000

EXPOSE 8000

CMD ["npx", "tsx", "examples/http-server.ts"]
