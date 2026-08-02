FROM node:18

WORKDIR /app

# Copy package descriptors first to lock caching layer
COPY package*.json ./

# Install application dependencies
RUN npm install

# Copy the entire workspace files
COPY . .

# Expose the configured app port
EXPOSE 7860

# Start the application server
CMD ["npm", "start"]
