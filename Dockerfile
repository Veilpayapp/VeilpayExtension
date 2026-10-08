# The Veilpay agent relay, containerized for any Docker host (Render, Koyeb,
# Fly, a VPS). Only the two zero-dependency directories are copied: no extension
# code, no node_modules, no build step.
FROM node:20-alpine

WORKDIR /app
COPY mcp/ ./mcp/
COPY relay/ ./relay/

# 0.0.0.0 so the container is reachable behind the host's proxy. Most platforms
# inject PORT, which server.mjs honours; 8788 is the default.
ENV VEILPAY_RELAY_HOST=0.0.0.0
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:8788/health || exit 1

CMD ["node", "relay/server.mjs"]
