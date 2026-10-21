FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -o /out/image .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/image /usr/local/bin/image
USER 65534
EXPOSE 8080
ENTRYPOINT ["image"]
