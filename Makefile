# Front door for common tasks. Everything here delegates to npm scripts or
# docker compose — nothing is implemented twice, so `make test` and
# `npm test` cannot drift apart.
#
# Run `make` with no target for the list.
#
# Three ways to run the app:
#   make dev        on the host  — fastest reload, what you want day to day
#   make up         in Docker    — dev containers, source mounted
#   make up-prod    in Docker    — built images, nginx, what deploys
#
# The VS Code extension is not in Docker and cannot be: it has no server
# process, only a bundle that the editor on your host loads. `make ext-watch`
# and `make ext-package` handle it here.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

# --env-file is explicit because Compose otherwise reads `./.env` by that exact
# name, and this repo's local file is `.env.development`. Without this, every
# ${VAR} in docker-compose.yml would substitute empty and the API would start
# with no OAuth credentials, failing its env validation at boot.
COMPOSE := docker compose --env-file .env.development

.DEFAULT_GOAL := help

.PHONY: help install build dev test lint format verify ship \
        up down logs ps up-prod down-prod build-images \
        db-up db-down reset psql db-url migrate s3-url \
        ext ext-deps ext-watch ext-package clean \
        tf-init tf-plan tf-apply tf-output \
        secrets-template secrets-check secrets-push \
        deploy-status deploy-logs deploy-version

help: ## Show this help
	@echo "sandbox-factory"
	@echo
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | sort \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
	@echo

## ---- host ---------------------------------------------------------------

install: node_modules ## Install dependencies (clean, lockfile-exact)

# Targets that need host dependencies depend on this, so a fresh clone works
# without a separate install step. The stamp means it runs once rather than on
# every invocation; npm ci rewrites node_modules wholesale, so the directory's
# own timestamp is the honest marker.
node_modules: package-lock.json
	npm ci
	@touch node_modules

build: node_modules ## Build every workspace, in dependency order
	npm run build

dev: node_modules ## Run API + web on the host with hot reload
	npm run dev

test: ## Test every workspace with coverage thresholds
	npm test

lint: ## Type-check every workspace
	npm run lint

format: ## Apply formatting
	npm run format

verify: ## Everything CI runs — the gate before pushing
	npm run verify

export TITLE

ship: ## Branch, verify, PR and merge the working tree (TITLE="fix: ...")
	@test -n "$$TITLE" || { echo 'usage: make ship TITLE="fix: what changed"'; exit 1; }
	@./scripts/ship.sh --title "$$TITLE" $(SHIP_ARGS)

## ---- docker: dev --------------------------------------------------------

# Build provenance, resolved here rather than in the containers: the repo is
# mounted into them, but node:22-alpine has no git binary, so the resolver
# inside would fall back to "unknown" and the version readout would lose its
# commit. Exported so compose substitutes them into the dev services.
#
# `?=` so an already-set value (CI, or a deliberate override) wins, and every
# assignment tolerates git failing rather than breaking `make up` over a
# version string.
BUILD_SHA ?= $(shell git rev-parse HEAD 2>/dev/null)
BUILD_REF ?= $(shell git rev-parse --abbrev-ref HEAD 2>/dev/null)
BUILD_DIRTY ?= $(shell test -n "$$(git status --porcelain 2>/dev/null)" && echo true || echo false)
export BUILD_SHA BUILD_REF BUILD_DIRTY

up: ## Start Postgres + API + web in containers (source mounted)
	$(COMPOSE) --profile dev up -d
	@echo "api  http://localhost:$${API_PORT:-4000}"
	@echo "web  http://localhost:$${WEB_PORT:-5173}"
	@echo "(first start installs dependencies inside the containers — give it a minute)"

down: ## Stop the dev containers, keeping data
	$(COMPOSE) --profile dev down

logs: ## Follow container logs
	$(COMPOSE) --profile dev logs -f

ps: ## Show container status
	$(COMPOSE) ps

## ---- docker: prod-style -------------------------------------------------

build-images: ## Build the production API and web images
	$(COMPOSE) --profile prod build

up-prod: ## Start the built images behind nginx
	$(COMPOSE) --profile prod up -d --wait
	@echo "web  http://localhost:$${WEB_PROD_PORT:-8080}  (nginx, proxies /api)"

down-prod: ## Stop the prod containers, keeping data
	$(COMPOSE) --profile prod down

## ---- database -----------------------------------------------------------

db-up: ## Start Postgres and SeaweedFS, and wait for them
	$(COMPOSE) up -d --wait postgres seaweedfs
	@echo "postgres  ready on localhost:$${POSTGRES_PORT:-5432}"
	@echo "seaweedfs ready on localhost:$${S3_PORT:-8333}  (s3)"

db-down: ## Stop Postgres and SeaweedFS, keeping data
	$(COMPOSE) stop postgres seaweedfs

# Delegates to the workspace script, like every other target here. Needs the
# database up, so it depends on db-up rather than failing on a closed port.
migrate: db-up ## Apply pending migrations to the local database
	DATABASE_URL="postgres://postgres:postgres@localhost:$${POSTGRES_PORT:-5432}/sandbox_factory" \
		npm run db:migrate --workspace @sandbox-factory/db

reset: ## Stop everything and DELETE the database and object-storage volumes
	$(COMPOSE) --profile dev --profile prod down -v

psql: ## Open a psql shell in the running container
	$(COMPOSE) exec postgres psql -U postgres -d sandbox_factory

db-url: ## Print the DATABASE_URL for the local database
	@echo "postgres://postgres:postgres@localhost:$${POSTGRES_PORT:-5432}/sandbox_factory"

s3-url: ## Print the S3 endpoint for the local SeaweedFS
	@echo "http://localhost:$${S3_PORT:-8333}"

## ---- vs code extension (host only) --------------------------------------

ext: ext-watch ## Alias for ext-watch

# esbuild inlines the workspace packages from their dist/, so those have to be
# built before it can resolve them — on a fresh clone they do not exist yet and
# the bundle fails with "Could not resolve". --filter pulls in exactly the
# dependencies the extension needs, in order.
ext-deps: node_modules
	npx turbo run build --filter=sandbox-factory-vscode^...

ext-watch: ext-deps ## Rebuild the extension on save; F5 in VS Code runs and reloads it
	@echo "Watching. In VS Code, press F5 (Run VS Code Extension) to launch it."
	@echo "That window reloads itself on each rebuild (debug.extensionHost.autoReload)."
	@echo "The extension needs the API running — 'make dev' in another terminal."
	npm run dev --workspace sandbox-factory-vscode

ext-package: ext-deps ## Build a .vsix into apps/extension/
	npm run build --workspace sandbox-factory-vscode
	cd apps/extension && npx --yes @vscode/vsce package --no-dependencies
	@echo "packaged:"; ls -1 apps/extension/*.vsix

## ---- infrastructure (aws) -----------------------------------------------
#
# Terraform lives in infra/ and is documented there. These targets are the
# handful of commands worth having at the front door; anything more involved is
# a direct terraform invocation in that directory.
#
# `tf-apply` is deliberately NOT run by CI. Applying is a decision — it can
# replace a database — so it stays a local action with a human reading the plan.

TF := terraform -chdir=infra

tf-init: ## Initialise Terraform against the remote state backend
	@test -f infra/backend.hcl || { \
	  echo "No infra/backend.hcl. Run ./infra/scripts/bootstrap-backend.sh first."; \
	  exit 1; \
	}
	$(TF) init -backend-config=backend.hcl

tf-plan: ## Show what Terraform would change
	$(TF) plan

tf-apply: ## Apply infrastructure changes (prompts before doing anything)
	$(TF) apply

tf-output: ## Print Terraform outputs
	$(TF) output

secrets-template: ## Generate .env.production (copies OAuth from .env, makes a fresh signing secret)
	./infra/scripts/secrets-template.sh

secrets-check: ## Validate .env.production before pushing it
	./infra/scripts/secrets-check.sh

secrets-push: secrets-check ## Push .env.production values into AWS Secrets Manager
	./infra/scripts/secrets-push.sh

## ---- deployment ---------------------------------------------------------

deploy-status: ## Show what the ECS service is currently running
	@aws ecs describe-services \
	  --cluster sandbox-factory \
	  --services sandbox-factory-api \
	  --query 'services[0].{running:runningCount,desired:desiredCount,status:status,taskDef:taskDefinition}' \
	  --output table

deploy-logs: ## Tail the production API logs
	aws logs tail /ecs/sandbox-factory-api --follow

deploy-version: ## Ask the live site which commit it is serving
	@curl -fsS https://platform.lunox.work/version && echo

## ---- housekeeping -------------------------------------------------------

clean: ## Remove build output and caches (keeps node_modules)
	rm -rf .turbo
	rm -rf packages/*/dist packages/*/dist-test
	rm -rf apps/*/dist apps/*/dist-test
