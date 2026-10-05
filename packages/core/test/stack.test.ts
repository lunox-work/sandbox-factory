import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectStack,
  LANGUAGE_SHARE_MIN,
  manifestKind,
  manifestNames,
  STACK_DETECTION_VERSION,
  STACK_MANIFEST_BYTES_MAX,
  STACK_MANIFESTS_MAX,
  stackManifests,
} from "../src/repo/stack.js";
import {
  canonicalStackName,
  normalizeStack,
  sameStackName,
  STACK_CATALOG,
  STACK_KINDS,
  STACK_LIMITS,
  stackTechnology,
} from "../src/stack.js";

const files = (...paths: string[]) => paths.map((path) => ({ path, size: 10 }));

test("every name and spelling in the catalog names one technology", () => {
  const seen = new Map<string, string>();
  for (const technology of STACK_CATALOG) {
    assert.ok(technology.name.length <= STACK_LIMITS.name, technology.name);
    for (const name of [technology.name, ...(technology.aliases ?? [])]) {
      const key = name.toLowerCase();
      assert.equal(seen.get(key), undefined, `${name} is named twice`);
      seen.set(key, technology.name);
    }
  }
  // Grouped by kind, in the order a picker shows them.
  const kinds = STACK_CATALOG.map(({ kind }) => STACK_KINDS.indexOf(kind));
  assert.deepEqual(
    kinds,
    [...kinds].sort((a, b) => a - b),
  );
});

test("a name typed in another spelling is stored as the catalog's", () => {
  assert.equal(canonicalStackName(" postgres "), "PostgreSQL");
  assert.equal(canonicalStackName("K8S"), "Kubernetes");
  assert.equal(canonicalStackName("cognito"), "Amazon Cognito");
  assert.equal(stackTechnology("csharp")?.kind, "language");
  // One the catalog lacks is kept as typed, its spaces collapsed.
  assert.equal(canonicalStackName("  Our   Billing API "), "Our Billing API");
  assert.equal(stackTechnology("Our Billing API"), undefined);
  assert.ok(sameStackName("pg", "PostgreSQL"));
  assert.ok(!sameStackName("MySQL", "PostgreSQL"));
});

test("a stack keeps each technology once, in the order first given", () => {
  assert.deepEqual(
    normalizeStack(["typescript", "Postgres", "TypeScript", " ", "pg", "Zod"]),
    ["TypeScript", "PostgreSQL", "Zod"],
  );
});

test("languages count by their share, and the largest always does", () => {
  assert.equal(LANGUAGE_SHARE_MIN, 0.1);
  assert.deepEqual(
    detectStack({
      languages: { TypeScript: 800, JavaScript: 50, Shell: 20, Java: 130 },
      files: [],
      manifests: [],
    }),
    ["TypeScript", "Java"],
  );
  // A repository of many small languages still has its largest.
  assert.deepEqual(
    detectStack({
      languages: { Go: 9, Python: 8, Ruby: 8, PHP: 8, C: 8, Rust: 59 },
      files: [],
      manifests: [],
    }),
    ["Rust"],
  );
  assert.deepEqual(
    detectStack({ languages: {}, files: [], manifests: [] }),
    [],
  );
});

test("frameworks and tools are found by the files only they leave", () => {
  assert.deepEqual(
    detectStack({
      languages: {},
      files: files(
        "apps/web/next.config.ts",
        "infra/main.tf",
        "Dockerfile",
        ".github/workflows/ci.yml",
        "manage.py",
        "deploy/Chart.yaml",
        "README.md",
      ),
      manifests: [],
    }),
    ["Next.js", "Django", "Docker", "Helm", "Terraform", "GitHub Actions"],
  );
});

test("vendored code, fixtures and examples are not the repository's stack", () => {
  assert.deepEqual(
    detectStack({
      languages: {},
      files: files(
        "vendor/rails/bin/rails",
        "test/fixtures/next.config.js",
        "examples/angular/angular.json",
      ),
      manifests: [
        {
          path: "node_modules/x/package.json",
          text: '{"dependencies":{"pg":"1"}}',
        },
      ],
    }),
    [],
  );
});

test("Postgres and Cognito are found in the packages a manifest names", () => {
  assert.deepEqual(
    detectStack({
      languages: { TypeScript: 100 },
      files: [],
      manifests: [
        {
          path: "package.json",
          text: JSON.stringify({
            dependencies: {
              react: "^19",
              pg: "^8",
              "@aws-sdk/client-cognito-identity-provider": "^3",
            },
            devDependencies: { vitest: "^3" },
          }),
        },
      ],
    }),
    ["TypeScript", "React", "PostgreSQL", "AWS", "Amazon Cognito", "Vitest"],
  );
});

test("each ecosystem's manifest is read for its dependency names", () => {
  const read = (path: string, text: string) =>
    detectStack({ languages: {}, files: [], manifests: [{ path, text }] });

  assert.deepEqual(
    read(
      "requirements.txt",
      "Django==5.0 # web\n-r base.txt\npsycopg2-binary>=2.9\n",
    ),
    ["Django", "PostgreSQL"],
  );
  assert.deepEqual(
    read(
      "pyproject.toml",
      '[project]\ndependencies = ["fastapi[all]>=0.110", "SQLAlchemy"]\n[tool.poetry.dependencies]\ncelery = "^5"\n',
    ),
    ["FastAPI", "Celery", "SQLAlchemy"],
  );
  assert.deepEqual(
    read(
      "pom.xml",
      "<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency><dependency><artifactId>postgresql</artifactId></dependency>",
    ),
    ["Spring Boot", "PostgreSQL"],
  );
  assert.deepEqual(
    read(
      "build.gradle.kts",
      'implementation("software.amazon.awssdk:cognitoidentityprovider:2.25.0")',
    ),
    ["AWS", "Amazon Cognito"],
  );
  assert.deepEqual(
    read(
      "src/Api/Api.csproj",
      '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="8" /></ItemGroup></Project>',
    ),
    ["ASP.NET Core", "PostgreSQL"],
  );
  assert.deepEqual(
    read(
      "go.mod",
      "module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgithub.com/jackc/pgx/v5 v5.5.0\n)\n",
    ),
    ["Gin", "PostgreSQL"],
  );
  assert.deepEqual(read("Gemfile", "gem 'rails', '~> 7.1'\ngem \"pg\"\n"), [
    "Ruby on Rails",
    "PostgreSQL",
  ]);
  assert.deepEqual(
    read("composer.json", '{"require":{"laravel/framework":"^11"}}'),
    ["Laravel"],
  );
  assert.deepEqual(
    read(
      "Cargo.toml",
      '[package]\nname = "app"\n[dependencies]\naxum = "0.7"\n[dependencies.tokio-postgres]\nversion = "0.7"\n',
    ),
    ["Axum", "PostgreSQL"],
  );
  assert.deepEqual(
    read("pubspec.yaml", "dependencies:\n  flutter:\n    sdk: flutter\n"),
    ["Flutter"],
  );
  assert.deepEqual(
    read(
      "docker-compose.yml",
      "services:\n  db:\n    image: postgres:16-alpine\n  cache:\n    image: 'bitnami/redis:7'\n  sql:\n    image: mcr.microsoft.com/mssql/server:2022-latest\n",
    ),
    ["PostgreSQL", "Microsoft SQL Server", "Redis"],
  );
  assert.deepEqual(
    read("Dockerfile", "FROM --platform=linux/amd64 node:22\n"),
    ["Node.js"],
  );
  assert.deepEqual(
    read(
      "infra/auth.tf",
      'resource "aws_cognito_user_pool" "main" {}\ndata "aws_s3_bucket" "assets" {}\n',
    ),
    ["AWS", "Amazon Cognito", "Amazon S3"],
  );
  // A manifest that does not parse adds nothing, and throws nothing.
  assert.deepEqual(read("package.json", "{ not json"), []);
  assert.deepEqual(manifestNames({ path: "README.md", text: "pg" }), []);
});

test("a manifest is told by its file name", () => {
  assert.equal(manifestKind("apps/web/package.json"), "npm");
  assert.equal(manifestKind("requirements-dev.txt"), "pypi");
  assert.equal(manifestKind("gradle/libs.versions.toml"), "maven");
  assert.equal(manifestKind("src/App/App.fsproj"), "nuget");
  assert.equal(manifestKind("compose.prod.yaml"), "docker");
  assert.equal(manifestKind("api.Dockerfile"), "docker");
  assert.equal(manifestKind("package-lock.json"), null);
});

test("the manifests read are the shallowest, capped, and none too large", () => {
  const many = [
    { path: "package.json", size: 100 },
    { path: "apps/web/package.json", size: 100 },
    { path: "huge/package.json", size: STACK_MANIFEST_BYTES_MAX + 1 },
    { path: "node_modules/a/package.json", size: 100 },
    { path: "src/index.ts", size: 100 },
    ...Array.from({ length: 20 }, (_, i) => ({
      path: `infra/m${String(i).padStart(2, "0")}.tf`,
      size: 100,
    })),
    ...Array.from({ length: 40 }, (_, i) => ({
      path: `services/s${String(i).padStart(2, "0")}/go.mod`,
      size: 100,
    })),
  ];
  const chosen = stackManifests(many);
  assert.equal(chosen.length, STACK_MANIFESTS_MAX);
  assert.equal(chosen[0], "package.json");
  assert.ok(chosen.includes("apps/web/package.json"));
  assert.ok(!chosen.includes("huge/package.json"));
  assert.ok(!chosen.some((path) => path.startsWith("node_modules/")));
  // Terraform sprawls; it is held to its share.
  assert.equal(chosen.filter((path) => path.endsWith(".tf")).length, 10);
  assert.equal(STACK_DETECTION_VERSION, 1);
});
