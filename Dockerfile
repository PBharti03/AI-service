# @b2y/ai-service is a library, not a running service. This image is its reproducible build: it installs the
# locked dependencies, runs the checks and packs the release. Jenkins runs it to publish with an npm token
# passed at runtime (never stored in the image).

FROM node:22-bookworm-slim AS build

WORKDIR /package

# Install the locked dependencies first for better Docker layer caching.
COPY package.json package-lock.json .npmrc ./
RUN npm ci \
    && npm cache clean --force

# Copy the source, run the checks and pack exactly what will be published.
COPY . .
RUN npm run verify \
    && mkdir -p /artifacts \
    && npm pack --pack-destination /artifacts

# Publishing runs as a non-root user; the token arrives as NPM_TOKEN and is written only to a temporary
# user config inside the running container.
RUN chown -R node:node /package /artifacts
USER node

CMD ["sh", "-c", "test -n \"$NPM_TOKEN\" || { echo 'NPM_TOKEN is required to publish' >&2; exit 1; }; printf '//registry.npmjs.org/:_authToken=%s\\n' \"$NPM_TOKEN\" > /tmp/.npmrc && NPM_CONFIG_USERCONFIG=/tmp/.npmrc npm publish /artifacts/*.tgz --access public; status=$?; rm -f /tmp/.npmrc; exit $status"]
