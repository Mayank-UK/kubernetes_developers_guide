FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

USER node

EXPOSE 9000

CMD ["node", "server.js"]
