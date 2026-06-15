# FastLogs server image.
#
# Debian-slim base (node:22-slim) is used instead of alpine so the native
# better-sqlite3 module installs cleanly: it has glibc prebuilt binaries, and if
# a build is needed the build-essential/python3 tools are present. node 22 is
# the current LTS and matches package.json (engines: node >= 18).

FROM node:22-slim

# Toolchain for compiling better-sqlite3 if no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps first for better layer caching. Only package manifests
# are copied here so a code change does not bust the dependency layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the application source (node_modules excluded via .dockerignore).
COPY . .

# Persisted data lives outside the image; mount these as volumes.
ENV DATA_DIR=/app/data \
    BLOB_DIR=/app/blobs \
    PORT=8787
RUN mkdir -p /app/data /app/blobs

# The HTTP port the server listens on (nginx/compose maps it).
EXPOSE 8787

# Liveness probe (also honoured by `docker run` without compose). Uses node -
# always present, and the slim base ships no curl/wget - to GET /api/health on
# the in-container loopback; exits 0 only on HTTP 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Drop privileges: the node:* images ship an unprivileged "node" user.
RUN chown -R node:node /app
USER node

CMD ["node", "src/server.js"]
