BIN := bin
GOFLAGS ?=
LDFLAGS := -s -w

.PHONY: all build install test vet fmt clean cross

all: build

build:
	go build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o $(BIN)/0xaf ./cmd/0xaf
	go build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o $(BIN)/import-knowledge ./cmd/import-knowledge

# Puts `0xaf` on PATH. Assets are embedded, so the binary works from anywhere;
# set OXAF_RE_HOME to point it at a project checkout for live skills/knowledge.
install:
	go install -ldflags "$(LDFLAGS)" ./cmd/0xaf ./cmd/import-knowledge

test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -w .

# Static single binaries for the usual lab targets.
cross:
	GOOS=linux  GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o $(BIN)/0xaf-linux-amd64  ./cmd/0xaf
	GOOS=linux  GOARCH=arm64 CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o $(BIN)/0xaf-linux-arm64  ./cmd/0xaf
	GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o $(BIN)/0xaf-darwin-amd64 ./cmd/0xaf
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o $(BIN)/0xaf-darwin-arm64 ./cmd/0xaf

clean:
	rm -rf $(BIN)
