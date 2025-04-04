#!/bin/sh

envsubst '$PROXY_PASS_URL $SERVER_NAME $WELCOME_HOST $DEPLOYER_HOST' < /etc/nginx/nginx.conf > /etc/nginx/nginx.tmp
mv /etc/nginx/nginx.tmp /etc/nginx/nginx.conf

if [ -n "$ACME_DIRECTORY" ]; then
    sleep 20 # wait for sslh to start (might not be needed)
    certbot --nginx -n --redirect --agree-tos --email "$ACME_EMAIL" --server "$ACME_DIRECTORY" -d "$(echo "$SERVER_NAME" | tr ' ' ',')" $CERTBOT_OPTIONS
    echo "downloaded certificate"
    nginx -s quit # otherwise cause conflict with Docker CMD
    echo "stopped nginx"
else
    echo "ACME_SERVER is not set. Skipping certbot command."
fi

crond