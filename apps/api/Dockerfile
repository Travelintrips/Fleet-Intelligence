FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts --package-lock=false
COPY tsconfig.json build.mjs ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --package-lock=false && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8080
# HTTPS is terminated by the Fleet reverse proxy. The local container healthcheck
# must send the expected forwarded protocol or the middleware redirects to HTTPS.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/api/healthz',{headers:{'x-forwarded-proto':'https'},signal:AbortSignal.timeout(2500)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
CMD ["node","--enable-source-maps","dist/index.mjs"]
