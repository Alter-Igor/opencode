FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g opencode-ai@1.18.33
RUN useradd -m -u 10001 agent && mkdir -p /data && chown agent:agent /data
USER agent
WORKDIR /work
