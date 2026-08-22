FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json ./
COPY server-app.ts ./
COPY ai ./ai
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 3001
CMD ["bun", "run", "server-app.ts"]
