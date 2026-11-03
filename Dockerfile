FROM node:20-alpine
RUN apk upgrade --no-cache
WORKDIR /app
COPY package*.json ./
# npm retiré à l'exécution : CVE de ses dépendances internes (tar, glob, minimatch…), control_center#19
RUN npm ci --omit=dev && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY . .
EXPOSE 3403
CMD ["node", "server.js"]
