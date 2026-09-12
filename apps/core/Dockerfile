FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json ./
COPY server-core.ts ./
COPY lib ./lib
COPY features ./features
USER bun
EXPOSE 3000
CMD ["bun", "run", "server-core.ts"]
