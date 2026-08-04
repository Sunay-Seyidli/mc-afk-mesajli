FROM node:18-alpine

WORKDIR /app

# Copy package descriptors first to lock caching layer
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev --no-audit --no-fund

# Copy the entire application files
COPY src ./src
COPY public ./public
COPY server.ts .

# Set default port for Hugging Face Spaces
ENV PORT=7860

# Expose the configured app port
EXPOSE 7860

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:7860/api/keep-alive', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start the application server
CMD ["node", "server.ts"]
