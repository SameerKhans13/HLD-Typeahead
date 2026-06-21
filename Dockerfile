FROM oven/bun:1-alpine AS base
WORKDIR /usr/src/app

# Copy configuration files and source code
COPY package.json tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY data ./data

# Install production dependencies
RUN bun install --production

# Expose server port
EXPOSE 3000

ENV PORT=3000
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
