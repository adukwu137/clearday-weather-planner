FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
