# Wave scrims bot — container image for a free host.
#
# The image is deliberately dumb: no config.json inside, so every id and secret comes
# from environment variables and the same image runs locally and in a container.

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# deps first, so a code change does not reinstall them
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY assets ./assets
COPY config.example.json ./

# state file lives here; mount a volume on a host that keeps disks
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=8080
ENV INGEST_PORT=8099
EXPOSE 8080
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
