FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY examples/http-server.ts examples/env.ts ./examples/

RUN npm ci && npm run build

# examples/http-server.ts is a demo whose resolveUser authenticates every caller
# as "u1", and it has no built-in secrets. It refuses to start on 0.0.0.0 unless
# you pass MCP_SECRET and explicitly accept an unauthenticated server:
#
#   docker run -p 8000:8000 \
#     -e MCP_SECRET="$(openssl rand -base64 32)" \
#     -e ALLOW_INSECURE_DEMO=1 \
#     <image>
#
# For anything reachable by others, build from your own app with a real resolveUser.
ENV HOST=0.0.0.0
ENV PORT=8000

EXPOSE 8000

CMD ["npx", "tsx", "examples/http-server.ts"]
