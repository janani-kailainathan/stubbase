FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json ./
COPY server-core.ts ./
USER bun
EXPOSE 3000
CMD ["bun", "run", "server-core.ts"]
