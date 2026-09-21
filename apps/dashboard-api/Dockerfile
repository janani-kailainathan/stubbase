FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json ./
COPY server-app.ts ./
# The vendored disposable-email list; server-app.ts reads it from its own dir.
COPY blocked-email-domains.txt ./
COPY ai ./ai
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 3001
CMD ["bun", "run", "server-app.ts"]
