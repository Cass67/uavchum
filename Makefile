.PHONY: build run lint vet vuln clean docker-build deploy bench-branches

BUILD_FLAGS := -ldflags="-s -w"
BINARY      := uavchum

build:
	go build $(BUILD_FLAGS) -o $(BINARY) .

run:
	go run .

lint:
	golangci-lint run ./...

vet:
	go vet ./...

vuln:
	govulncheck ./...

clean:
	rm -f $(BINARY)

docker-build:
	docker build -t uavchum .

deploy:
	ansible-playbook deploy/deploy.yml

bench-branches:
	./scripts/benchmark_branches.sh main HEAD
