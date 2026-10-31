# Frontend = dashboard + the teaching guide. Builds with the REPO ROOT as
# context (docker build -f .docker/frontend/Dockerfile .) because it bakes
# in files from three places: frontend/, the repo-root GUIDE.md, and the
# vendored renderer downloaded below. Any other context fails loudly on the
# first COPY.
#
# GUIDE.md IS CONTENT OF THE IMAGE: editing GUIDE.md changes nothing at
# runtime until the image is rebuilt and redeployed (rebuild + kind load +
# rollout restart). The guide page fetches /GUIDE.md; there is no
# volume/CDN indirection.

FROM nginx:1.27-alpine

# Client-side markdown renderer, vendored at PINNED versions from jsdelivr at
# BUILD time only — no CDN at runtime, no vendored copies in the repo.
# sha256s pin the exact artifacts (supply-chain hygiene).
ARG MARKED_VERSION=12.0.2
ARG HIGHLIGHTJS_VERSION=11.11.1
RUN apk add --no-cache curl \
 && mkdir -p /usr/share/nginx/html/vendor \
 && curl -fsSL -o /usr/share/nginx/html/vendor/marked.min.js \
      "https://cdn.jsdelivr.net/npm/marked@${MARKED_VERSION}/marked.min.js" \
 && curl -fsSL -o /usr/share/nginx/html/vendor/highlight.min.js \
      "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@${HIGHLIGHTJS_VERSION}/build/highlight.min.js" \
 && curl -fsSL -o /usr/share/nginx/html/vendor/highlight-github-dark.min.css \
      "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@${HIGHLIGHTJS_VERSION}/build/styles/github-dark.min.css" \
 && cd /usr/share/nginx/html/vendor \
 && echo "15fabce5b65898b32b03f5ed25e9f891a729ad4c0d6d877110a7744aa847a894  marked.min.js" \
 && echo "c4a399dd6f488bc97a3546e3476747b3e714c99c57b9473154c6fb8d259b9381  highlight.min.js" \
 && echo "9f208d022102b1d0c7aebfecd8e42ca7997d5de636649d2b31ea63093d809019  highlight-github-dark.min.css" \
 | sha256sum -c - \
 && apk del curl

# *.html: the guide page (index.html, served at /) + the dashboard
# (app.html). js/ carries the analytics wrapper (inert without the beacon
# tag swapped in below, so it ships in every build unconditionally).
COPY frontend/*.html /usr/share/nginx/html/
COPY frontend/favicon.ico /usr/share/nginx/html/
COPY frontend/js/ /usr/share/nginx/html/js/
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY GUIDE.md /usr/share/nginx/html/GUIDE.md

# Umami analytics (self-hosted, https://umami.mayankcodeworks.com): every
# served page's <head> carries the beacon tag with __UMAMI_SRC__/__UMAMI_ID__
# placeholder tokens. The values are PUBLIC (visible in the served page
# source anyway), so they arrive as plain build args from repo Variables,
# never secrets. BOTH must be non-empty to enable: the sed swaps the tokens
# in every served page (| delimiter — the values contain / and :). With
# either empty the beacon line is DELETED instead: an emptied src="" is NOT
# a no-op (browsers resolve it to the page's own URL and re-fetch the
# document as a script), so unconfigured builds — local preview, the lab
# images, CI before the Variables exist — ship no tag at all and the pages'
# analytics wrapper no-ops.
ARG UMAMI_SRC=
ARG UMAMI_ID=
RUN if [ -n "$UMAMI_SRC" ] && [ -n "$UMAMI_ID" ]; then \
        sed -i "s|__UMAMI_SRC__|${UMAMI_SRC}|g; s|__UMAMI_ID__|${UMAMI_ID}|g" /usr/share/nginx/html/*.html; \
    else \
        sed -i '/__UMAMI_SRC__/d' /usr/share/nginx/html/*.html; \
    fi

# Faro crash telemetry (Grafana, public collector): every served page's
# <head> also carries a faro-web-sdk beacon tag with __FARO_URL__/__FARO_APP__
# placeholder tokens (the CDN src itself is a pinned constant in the HTML).
# Same discipline as Umami: BOTH args non-empty -> sed swaps the tokens in
# every served page; either empty -> the beacon line is DELETED so
# unconfigured builds ship no CDN script tag at all and js/faro.js (shipped
# unconditionally) inert-no-ops. Values are PUBLIC build args, never secrets.
ARG FARO_URL=
ARG FARO_APP=
RUN if [ -n "$FARO_URL" ] && [ -n "$FARO_APP" ]; then \
        sed -i "s|__FARO_URL__|${FARO_URL}|g; s|__FARO_APP__|${FARO_APP}|g" /usr/share/nginx/html/*.html; \
    else \
        sed -i '/__FARO_URL__/d' /usr/share/nginx/html/*.html; \
    fi

# Syntax-gate the shipped config at build time (this image's "test").
# nginx -t resolves static proxy_pass upstreams at parse time, but
# facts/image/loadgen only exist at runtime — and BuildKit mounts
# /etc/hosts read-only during RUN. So test a copy of the real config
# with upstream hostnames rewritten to 127.0.0.1 (resolution is all
# nginx -t needs; no connection is made). The shipped config is
# untouched, and the temp files never leave this layer's check.
RUN sed -E 's#(proxy_pass https?://)([a-z]+):([0-9]+)#\1127.0.0.1:\3#' \
      /etc/nginx/conf.d/default.conf > /tmp/default.conf \
 && printf 'events {}\nhttp { include /tmp/default.conf; }\n' > /tmp/nginx-test.conf \
 && nginx -t -c /tmp/nginx-test.conf \
 && rm -f /tmp/default.conf /tmp/nginx-test.conf

EXPOSE 80
