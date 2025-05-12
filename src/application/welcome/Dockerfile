FROM node:24.0.1 AS base

WORKDIR /app

RUN apt-get update && apt-get install -y \
    ruby \ 
    ruby-dev \ 
    && gem install bundler jekyll \
    && npm install -g gulp

COPY neumorphism/Gemfile .
COPY neumorphism/Gemfile.lock .
RUN bundle install

COPY neumorphism/package.json .
COPY neumorphism/yarn.lock .
RUN yarn

COPY neumorphism .

RUN gulp compile

FROM nginx:1.28.0-alpine3.21

WORKDIR /app

COPY --from=base /app/_site .

COPY entrypoint.sh /docker-entrypoint.d/entrypoint.sh
RUN chmod +x /docker-entrypoint.d/entrypoint.sh
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 3000