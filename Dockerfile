FROM node:22-alpine

WORKDIR /app

COPY container/package.json .
RUN npm install

COPY container/server.js .

EXPOSE 8080

CMD ["node", "server.js"]
