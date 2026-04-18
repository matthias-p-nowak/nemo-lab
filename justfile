set shell := ["bash", "-euo", "pipefail", "-c"]

default_port := "7255"
config_file := "nemo.toml"
binary_name := "nemo"

_set-port port:
    sed -i 's/^listen_addr = ":[0-9]*"/listen_addr = ":{{port}}"/' {{config_file}}

copy-resources:
    mkdir -p dist
    cp -r frontend/resources/. dist/

build-css:
    mkdir -p dist/css
    sass frontend/src/main.scss:dist/css/main.css

build-js:
    mkdir -p dist/js
    esbuild --bundle frontend/src/main.ts --outdir=dist/js --sourcemap

build: copy-resources build-css build-js

publish port=default_port: (_set-port port) build
    cd backend && go build -o ../dist/bin/{{binary_name}} ./cmd/server

run port=default_port: (publish port) 
    dist/bin/nemo -config {{config_file}}

clean:
    rm -frv dist
