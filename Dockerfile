# Demo image. For anything you deploy, pin the base by digest (node:22-slim@sha256:…)
# and rebuild on a schedule so it picks up OS and Node security patches.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY examples/http-server.ts examples/env.ts ./examples/

# No dependency install scripts: nothing the demo builds or runs needs them.
RUN npm ci --ignore-scripts && npm run build

# examples/http-server.ts is a demo whose resolveUser authenticates every caller
# as "u1", and it has no built-in secrets. It refuses to start on 0.0.0.0 unless
# you pass MCP_SECRET and explicitly accept an unauthenticated server:
#
#   docker run -p 8000:8000 \
#     -e MCP_SECRET="$(openssl rand -base64 32)" \
#     -e ALLOW_INSECURE_DEMO=1 \
#     <image>
#
# The server answers only to Host 127.0.0.1 / localhost / [::1] on its own port
# (DNS-rebinding guard). With a remapped port or another hostname, list the
# Host values: -e ALLOWED_HOSTS="localhost:9000" (and `-p 9000:8000`; the
# advertised origin stays http://127.0.0.1:$PORT, so a remapped port also needs
# a matching PORT).
#
# For anything reachable by others, build from your own app with a real resolveUser.
# The demo needs no privileges; don't run it as root.
USER node

ENV HOST=0.0.0.0
ENV PORT=8000

EXPOSE 8000

# 200 once the server is up and serving its discovery document.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/.well-known/oauth-protected-resource/mcp').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["npx", "tsx", "examples/http-server.ts"]
