FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json ./
COPY server-core.ts ./
# The vendored disposable-email list; features/auth reads it from the app root.
COPY blocked-email-domains.txt ./
COPY lib ./lib
COPY features ./features
USER bun
EXPOSE 3000
CMD ["bun", "run", "server-core.ts"]
