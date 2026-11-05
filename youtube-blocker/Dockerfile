FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY vendor ./vendor
ENV PORT=8080 DATA_DIR=/data TZ=Europe/Copenhagen
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
