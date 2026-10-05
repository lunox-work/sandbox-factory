/**
 * A tech stack: the languages, frameworks, databases, services and tools a
 * piece of work is done in.
 *
 * **One list, not one per kind.** A person picking Postgres should not have
 * to decide whether it is a database or a service first, and a repository's
 * stack and a bounty's additions merge without a rule per field. Each entry
 * in the catalog carries its kind, which is how a picker groups them; an
 * entry nobody catalogued is kept as typed, with no kind.
 *
 * **Names, not ids.** A stack is stored as the names a person reads, so a
 * stored list says what it means without the catalog beside it, and an
 * entry the catalog lacks is stored the same way as one it has. A name
 * typed or detected in another spelling (`postgres`, `k8s`) is stored under
 * the catalog's own (`PostgreSQL`, `Kubernetes`).
 *
 * Each entry also says how it shows itself in a repository (`detect`), read
 * by `repo/stack.ts`: one row per technology, so naming one and recognising
 * it cannot drift apart.
 */

export const STACK_KINDS = [
  "language",
  "framework",
  "database",
  "service",
  "tool",
] as const;
export type StackKind = (typeof STACK_KINDS)[number];

/** How many entries one stack holds, and how long a name may be. */
export const STACK_LIMITS = { items: 30, name: 40 } as const;

/**
 * Where a technology shows itself in a repository. Package names are
 * matched without regard to case; one ending in `*` matches every name it
 * starts. `files` globs over a file's name, or over its path when the
 * pattern has a `/`.
 */
export interface StackSignals {
  /** GitHub's names for the language, as its language totals give them. */
  readonly linguist?: readonly string[];
  readonly files?: readonly string[];
  readonly npm?: readonly string[];
  readonly pypi?: readonly string[];
  /** Artifact ids, or `group:artifact`. */
  readonly maven?: readonly string[];
  /** Package ids, and a project's SDK. */
  readonly nuget?: readonly string[];
  /** Module paths. */
  readonly go?: readonly string[];
  readonly gem?: readonly string[];
  readonly composer?: readonly string[];
  readonly cargo?: readonly string[];
  readonly pub?: readonly string[];
  /** Image names, without registry or tag: `postgres`, `mssql/server`. */
  readonly docker?: readonly string[];
  /** Resource and data source types. */
  readonly terraform?: readonly string[];
}

/** The kinds of manifest a dependency name is read from. */
export type StackEcosystem = Exclude<keyof StackSignals, "linguist" | "files">;

export interface StackTechnology {
  /** What is shown, and what is stored. */
  readonly name: string;
  readonly kind: StackKind;
  /** Other spellings, typed or detected, stored under `name`. */
  readonly aliases?: readonly string[];
  readonly detect?: StackSignals;
}

/** AWS's per-service packages, named the same way across its SDKs. */
function awsService(service: string, terraform: readonly string[]) {
  return {
    npm: [`@aws-sdk/client-${service}`],
    maven: [service, `aws-java-sdk-${service}`],
    nuget: [`awssdk.${service}`],
    go: [`github.com/aws/aws-sdk-go-v2/service/${service}`],
    terraform,
  } satisfies StackSignals;
}

/**
 * Every technology a picker offers, grouped by kind in `STACK_KINDS` order,
 * which is also the order a detected stack is listed in.
 */
export const STACK_CATALOG: readonly StackTechnology[] = [
  // Languages.
  {
    name: "TypeScript",
    kind: "language",
    aliases: ["ts"],
    detect: { linguist: ["TypeScript"] },
  },
  {
    name: "JavaScript",
    kind: "language",
    aliases: ["js"],
    detect: { linguist: ["JavaScript"] },
  },
  {
    name: "Python",
    kind: "language",
    aliases: ["py"],
    detect: { linguist: ["Python"] },
  },
  { name: "Java", kind: "language", detect: { linguist: ["Java"] } },
  { name: "Kotlin", kind: "language", detect: { linguist: ["Kotlin"] } },
  {
    name: "C#",
    kind: "language",
    aliases: ["csharp", "c sharp"],
    detect: { linguist: ["C#"] },
  },
  {
    name: "Go",
    kind: "language",
    aliases: ["golang"],
    detect: { linguist: ["Go"] },
  },
  { name: "Rust", kind: "language", detect: { linguist: ["Rust"] } },
  { name: "Ruby", kind: "language", detect: { linguist: ["Ruby"] } },
  { name: "PHP", kind: "language", detect: { linguist: ["PHP"] } },
  { name: "Swift", kind: "language", detect: { linguist: ["Swift"] } },
  { name: "Dart", kind: "language", detect: { linguist: ["Dart"] } },
  { name: "Scala", kind: "language", detect: { linguist: ["Scala"] } },
  { name: "Elixir", kind: "language", detect: { linguist: ["Elixir"] } },
  { name: "C", kind: "language", detect: { linguist: ["C"] } },
  {
    name: "C++",
    kind: "language",
    aliases: ["cpp"],
    detect: { linguist: ["C++"] },
  },

  // Frameworks and runtimes.
  {
    name: "Node.js",
    kind: "framework",
    aliases: ["node", "nodejs"],
    detect: {
      files: [".nvmrc", ".node-version"],
      npm: ["@types/node", "tsx", "ts-node", "nodemon"],
      docker: ["node"],
    },
  },
  {
    name: "React",
    kind: "framework",
    aliases: ["react.js", "reactjs"],
    detect: { npm: ["react"] },
  },
  {
    name: "Next.js",
    kind: "framework",
    aliases: ["next", "nextjs"],
    detect: { files: ["next.config.*"], npm: ["next"] },
  },
  {
    name: "Vue",
    kind: "framework",
    aliases: ["vue.js", "vuejs"],
    detect: { npm: ["vue"] },
  },
  {
    name: "Nuxt",
    kind: "framework",
    detect: { files: ["nuxt.config.*"], npm: ["nuxt"] },
  },
  {
    name: "Angular",
    kind: "framework",
    detect: { files: ["angular.json"], npm: ["@angular/core"] },
  },
  { name: "Svelte", kind: "framework", detect: { npm: ["svelte"] } },
  { name: "SvelteKit", kind: "framework", detect: { npm: ["@sveltejs/kit"] } },
  { name: "Astro", kind: "framework", detect: { npm: ["astro"] } },
  { name: "Remix", kind: "framework", detect: { npm: ["@remix-run/*"] } },
  {
    name: "React Native",
    kind: "framework",
    detect: { npm: ["react-native"] },
  },
  { name: "Expo", kind: "framework", detect: { npm: ["expo"] } },
  { name: "Electron", kind: "framework", detect: { npm: ["electron"] } },
  {
    name: "Flutter",
    kind: "framework",
    detect: { pub: ["flutter"] },
  },
  {
    name: "Tailwind CSS",
    kind: "framework",
    aliases: ["tailwind"],
    detect: { files: ["tailwind.config.*"], npm: ["tailwindcss"] },
  },
  {
    name: "Express",
    kind: "framework",
    aliases: ["express.js", "expressjs"],
    detect: { npm: ["express"] },
  },
  { name: "Fastify", kind: "framework", detect: { npm: ["fastify"] } },
  {
    name: "NestJS",
    kind: "framework",
    aliases: ["nest"],
    detect: { npm: ["@nestjs/core"] },
  },
  { name: "Hono", kind: "framework", detect: { npm: ["hono"] } },
  { name: "Koa", kind: "framework", detect: { npm: ["koa"] } },
  {
    name: "GraphQL",
    kind: "framework",
    detect: {
      npm: ["graphql", "@apollo/server", "apollo-server*"],
      pypi: ["graphene", "strawberry-graphql", "ariadne"],
      maven: ["graphql-java", "spring-boot-starter-graphql"],
      nuget: ["hotchocolate*", "graphql"],
      go: ["github.com/99designs/gqlgen"],
      gem: ["graphql"],
    },
  },
  { name: "tRPC", kind: "framework", detect: { npm: ["@trpc/server"] } },
  {
    name: "Django",
    kind: "framework",
    detect: { files: ["manage.py"], pypi: ["django"] },
  },
  { name: "Flask", kind: "framework", detect: { pypi: ["flask"] } },
  { name: "FastAPI", kind: "framework", detect: { pypi: ["fastapi"] } },
  { name: "Celery", kind: "framework", detect: { pypi: ["celery"] } },
  {
    name: "Spring Boot",
    kind: "framework",
    aliases: ["spring"],
    detect: {
      maven: ["spring-boot*", "org.springframework.boot*"],
    },
  },
  { name: "Quarkus", kind: "framework", detect: { maven: ["quarkus-*"] } },
  {
    name: ".NET",
    kind: "framework",
    aliases: ["dotnet", ".net core"],
    detect: { files: ["*.csproj", "*.fsproj", "*.sln"] },
  },
  {
    name: "ASP.NET Core",
    kind: "framework",
    aliases: ["asp.net", "aspnet core", "aspnetcore"],
    detect: { nuget: ["microsoft.aspnetcore.*", "microsoft.net.sdk.web"] },
  },
  {
    name: "Ruby on Rails",
    kind: "framework",
    aliases: ["rails"],
    detect: { files: ["bin/rails", "config/routes.rb"], gem: ["rails"] },
  },
  {
    name: "Laravel",
    kind: "framework",
    detect: { files: ["artisan"], composer: ["laravel/framework"] },
  },
  {
    name: "Symfony",
    kind: "framework",
    detect: { composer: ["symfony/framework-bundle"] },
  },
  {
    name: "Gin",
    kind: "framework",
    detect: { go: ["github.com/gin-gonic/gin"] },
  },
  {
    name: "Echo",
    kind: "framework",
    detect: { go: ["github.com/labstack/echo*"] },
  },
  {
    name: "Fiber",
    kind: "framework",
    detect: { go: ["github.com/gofiber/fiber*"] },
  },
  { name: "Actix Web", kind: "framework", detect: { cargo: ["actix-web"] } },
  { name: "Axum", kind: "framework", detect: { cargo: ["axum"] } },

  // Databases, caches and queues.
  {
    name: "PostgreSQL",
    kind: "database",
    aliases: ["postgres", "pg", "psql"],
    detect: {
      npm: ["pg", "postgres", "pg-promise", "@neondatabase/serverless"],
      pypi: ["psycopg", "psycopg2", "psycopg2-binary", "asyncpg"],
      maven: ["postgresql", "r2dbc-postgresql"],
      nuget: ["npgsql*"],
      go: ["github.com/jackc/pgx*", "github.com/lib/pq"],
      gem: ["pg"],
      cargo: ["tokio-postgres", "postgres"],
      docker: ["postgres", "postgresql", "postgis/postgis"],
    },
  },
  {
    name: "MySQL",
    kind: "database",
    detect: {
      npm: ["mysql", "mysql2"],
      pypi: ["pymysql", "mysqlclient", "mysql-connector-python"],
      maven: ["mysql-connector-java", "mysql-connector-j"],
      nuget: [
        "mysql.data",
        "mysqlconnector",
        "pomelo.entityframeworkcore.mysql",
      ],
      go: ["github.com/go-sql-driver/mysql"],
      gem: ["mysql2"],
      docker: ["mysql"],
    },
  },
  {
    name: "MariaDB",
    kind: "database",
    detect: { npm: ["mariadb"], docker: ["mariadb"] },
  },
  {
    name: "Microsoft SQL Server",
    kind: "database",
    aliases: ["sql server", "mssql"],
    detect: {
      npm: ["mssql", "tedious"],
      pypi: ["pyodbc", "pymssql"],
      maven: ["mssql-jdbc"],
      nuget: ["microsoft.data.sqlclient", "system.data.sqlclient"],
      docker: ["mssql/server"],
    },
  },
  {
    name: "SQLite",
    kind: "database",
    detect: {
      npm: ["better-sqlite3", "sqlite3", "sqlite"],
      nuget: ["microsoft.data.sqlite*"],
      go: ["github.com/mattn/go-sqlite3"],
      gem: ["sqlite3"],
    },
  },
  {
    name: "MongoDB",
    kind: "database",
    aliases: ["mongo"],
    detect: {
      npm: ["mongodb", "mongoose"],
      pypi: ["pymongo", "motor"],
      maven: ["mongodb-driver*", "spring-boot-starter-data-mongodb"],
      nuget: ["mongodb.driver"],
      go: ["go.mongodb.org/mongo-driver*"],
      gem: ["mongoid", "mongo"],
      docker: ["mongo"],
    },
  },
  {
    name: "Redis",
    kind: "database",
    detect: {
      npm: ["redis", "ioredis", "@upstash/redis"],
      pypi: ["redis"],
      maven: ["jedis", "lettuce-core", "spring-boot-starter-data-redis"],
      nuget: ["stackexchange.redis"],
      go: ["github.com/redis/go-redis*", "github.com/go-redis/redis*"],
      gem: ["redis"],
      docker: ["redis", "valkey/valkey"],
    },
  },
  {
    name: "Elasticsearch",
    kind: "database",
    detect: {
      npm: ["@elastic/elasticsearch"],
      pypi: ["elasticsearch"],
      maven: ["elasticsearch-java"],
      nuget: ["elastic.clients.elasticsearch", "nest"],
      docker: ["elasticsearch"],
    },
  },
  {
    name: "Amazon DynamoDB",
    kind: "database",
    aliases: ["dynamodb", "dynamo"],
    detect: {
      ...awsService("dynamodb", ["aws_dynamodb_*"]),
      npm: ["@aws-sdk/client-dynamodb", "@aws-sdk/lib-dynamodb"],
    },
  },
  {
    name: "Apache Kafka",
    kind: "database",
    aliases: ["kafka"],
    detect: {
      npm: ["kafkajs"],
      pypi: ["kafka-python", "confluent-kafka"],
      maven: ["kafka-clients", "spring-kafka"],
      nuget: ["confluent.kafka"],
      docker: ["kafka", "confluentinc/cp-kafka"],
    },
  },
  {
    name: "RabbitMQ",
    kind: "database",
    detect: {
      npm: ["amqplib"],
      pypi: ["pika"],
      maven: ["amqp-client", "spring-boot-starter-amqp"],
      nuget: ["rabbitmq.client"],
      docker: ["rabbitmq"],
    },
  },

  // Cloud and third-party services.
  {
    name: "AWS",
    kind: "service",
    aliases: ["amazon web services"],
    detect: {
      npm: ["@aws-sdk/*", "aws-sdk"],
      pypi: ["boto3"],
      maven: ["software.amazon.awssdk*", "aws-java-sdk*"],
      nuget: ["awssdk.*"],
      go: ["github.com/aws/aws-sdk-go*"],
      terraform: ["aws_*"],
    },
  },
  {
    name: "Amazon Cognito",
    kind: "service",
    aliases: ["cognito", "aws cognito"],
    detect: {
      npm: [
        "@aws-sdk/client-cognito-identity-provider",
        "@aws-sdk/client-cognito-identity",
        "amazon-cognito-identity-js",
        "aws-jwt-verify",
      ],
      pypi: ["pycognito"],
      maven: ["cognitoidentityprovider", "aws-java-sdk-cognitoidp"],
      nuget: [
        "awssdk.cognitoidentityprovider",
        "amazon.extensions.cognitoauthentication",
      ],
      go: ["github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider"],
      terraform: ["aws_cognito_*"],
    },
  },
  {
    name: "Amazon S3",
    kind: "service",
    aliases: ["s3", "aws s3"],
    detect: awsService("s3", ["aws_s3_*"]),
  },
  {
    name: "AWS Lambda",
    kind: "service",
    aliases: ["lambda"],
    detect: {
      ...awsService("lambda", ["aws_lambda_*"]),
      npm: ["@aws-sdk/client-lambda", "@types/aws-lambda"],
      maven: ["aws-lambda-java-core"],
      nuget: ["amazon.lambda.*"],
      go: ["github.com/aws/aws-lambda-go"],
    },
  },
  {
    name: "Amazon SQS",
    kind: "service",
    aliases: ["sqs"],
    detect: awsService("sqs", ["aws_sqs_*"]),
  },
  {
    name: "Amazon SNS",
    kind: "service",
    aliases: ["sns"],
    detect: awsService("sns", ["aws_sns_*"]),
  },
  {
    name: "Amazon RDS",
    kind: "service",
    aliases: ["rds"],
    detect: awsService("rds", ["aws_db_instance", "aws_rds_*"]),
  },
  {
    name: "Amazon ECS",
    kind: "service",
    aliases: ["ecs"],
    detect: awsService("ecs", ["aws_ecs_*"]),
  },
  {
    name: "Google Cloud",
    kind: "service",
    aliases: ["gcp", "google cloud platform"],
    detect: {
      npm: ["@google-cloud/*"],
      pypi: ["google-cloud-*"],
      maven: ["com.google.cloud*", "google-cloud-*"],
      go: ["cloud.google.com/go*"],
      terraform: ["google_*"],
    },
  },
  {
    name: "Azure",
    kind: "service",
    aliases: ["microsoft azure"],
    detect: {
      npm: ["@azure/*"],
      pypi: ["azure-*"],
      maven: ["com.azure*", "azure-*"],
      nuget: ["azure.*"],
      terraform: ["azurerm_*"],
    },
  },
  {
    name: "Firebase",
    kind: "service",
    detect: {
      files: ["firebase.json"],
      npm: ["firebase", "firebase-admin"],
      pypi: ["firebase-admin"],
    },
  },
  {
    name: "Supabase",
    kind: "service",
    detect: {
      files: ["supabase/config.toml"],
      npm: ["@supabase/supabase-js"],
      pypi: ["supabase"],
    },
  },
  {
    name: "Stripe",
    kind: "service",
    detect: {
      npm: ["stripe", "@stripe/stripe-js"],
      pypi: ["stripe"],
      maven: ["stripe-java"],
      nuget: ["stripe.net"],
      go: ["github.com/stripe/stripe-go*"],
      gem: ["stripe"],
    },
  },
  {
    name: "Auth0",
    kind: "service",
    detect: { npm: ["auth0", "@auth0/*"], pypi: ["auth0-python"] },
  },
  { name: "Clerk", kind: "service", detect: { npm: ["@clerk/*"] } },
  {
    name: "Twilio",
    kind: "service",
    detect: { npm: ["twilio"], pypi: ["twilio"], nuget: ["twilio"] },
  },
  {
    name: "SendGrid",
    kind: "service",
    detect: { npm: ["@sendgrid/*"], pypi: ["sendgrid"], nuget: ["sendgrid"] },
  },
  {
    name: "Slack",
    kind: "service",
    detect: { npm: ["@slack/*"], pypi: ["slack-sdk", "slack-bolt"] },
  },
  {
    name: "OpenAI",
    kind: "service",
    detect: { npm: ["openai"], pypi: ["openai"] },
  },
  {
    name: "Anthropic",
    kind: "service",
    detect: { npm: ["@anthropic-ai/*"], pypi: ["anthropic"] },
  },
  {
    name: "Sentry",
    kind: "service",
    detect: { npm: ["@sentry/*"], pypi: ["sentry-sdk"], nuget: ["sentry*"] },
  },
  { name: "Vercel", kind: "service", detect: { files: ["vercel.json"] } },
  { name: "Netlify", kind: "service", detect: { files: ["netlify.toml"] } },
  { name: "Fly.io", kind: "service", detect: { files: ["fly.toml"] } },

  // Tools: infrastructure, build, data access and tests.
  {
    name: "Docker",
    kind: "tool",
    detect: {
      files: [
        "Dockerfile",
        "*.dockerfile",
        "docker-compose*.y*ml",
        "compose.y*ml",
      ],
    },
  },
  {
    name: "Kubernetes",
    kind: "tool",
    aliases: ["k8s"],
    detect: { files: ["kustomization.y*ml", "k8s/*.y*ml"] },
  },
  { name: "Helm", kind: "tool", detect: { files: ["Chart.yaml"] } },
  {
    name: "Terraform",
    kind: "tool",
    detect: { files: ["*.tf"] },
  },
  {
    name: "AWS CDK",
    kind: "tool",
    aliases: ["cdk"],
    detect: { files: ["cdk.json"], npm: ["aws-cdk-lib", "aws-cdk"] },
  },
  {
    name: "Serverless Framework",
    kind: "tool",
    detect: {
      files: ["serverless.y*ml", "serverless.ts"],
      npm: ["serverless"],
    },
  },
  {
    name: "GitHub Actions",
    kind: "tool",
    detect: { files: [".github/workflows/*.y*ml"] },
  },
  { name: "GitLab CI", kind: "tool", detect: { files: [".gitlab-ci.yml"] } },
  {
    name: "Turborepo",
    kind: "tool",
    detect: { files: ["turbo.json"], npm: ["turbo"] },
  },
  { name: "Nx", kind: "tool", detect: { files: ["nx.json"], npm: ["nx"] } },
  {
    name: "Vite",
    kind: "tool",
    detect: { files: ["vite.config.*"], npm: ["vite"] },
  },
  {
    name: "Webpack",
    kind: "tool",
    detect: { files: ["webpack.config.*"], npm: ["webpack"] },
  },
  {
    name: "Maven",
    kind: "tool",
    detect: { files: ["pom.xml"] },
  },
  {
    name: "Gradle",
    kind: "tool",
    detect: { files: ["build.gradle", "build.gradle.kts"] },
  },
  {
    name: "Prisma",
    kind: "tool",
    detect: { files: ["schema.prisma"], npm: ["prisma", "@prisma/client"] },
  },
  {
    name: "Drizzle",
    kind: "tool",
    detect: { files: ["drizzle.config.*"], npm: ["drizzle-orm"] },
  },
  { name: "TypeORM", kind: "tool", detect: { npm: ["typeorm"] } },
  { name: "Sequelize", kind: "tool", detect: { npm: ["sequelize"] } },
  { name: "SQLAlchemy", kind: "tool", detect: { pypi: ["sqlalchemy"] } },
  {
    name: "Hibernate",
    kind: "tool",
    detect: { maven: ["hibernate-core", "spring-boot-starter-data-jpa"] },
  },
  {
    name: "Entity Framework",
    kind: "tool",
    aliases: ["ef core", "entity framework core"],
    detect: { nuget: ["microsoft.entityframeworkcore*"] },
  },
  {
    name: "Jest",
    kind: "tool",
    detect: { files: ["jest.config.*"], npm: ["jest"] },
  },
  {
    name: "Vitest",
    kind: "tool",
    detect: { files: ["vitest.config.*"], npm: ["vitest"] },
  },
  {
    name: "Playwright",
    kind: "tool",
    detect: {
      files: ["playwright.config.*"],
      npm: ["@playwright/test", "playwright"],
      pypi: ["playwright"],
    },
  },
  {
    name: "Cypress",
    kind: "tool",
    detect: { files: ["cypress.config.*"], npm: ["cypress"] },
  },
  { name: "pytest", kind: "tool", detect: { pypi: ["pytest"] } },
  {
    name: "JUnit",
    kind: "tool",
    detect: { maven: ["junit", "junit-jupiter*", "junit-bom"] },
  },
  {
    name: "Storybook",
    kind: "tool",
    detect: { npm: ["storybook", "@storybook/*"] },
  },
];

/** A name as it is compared: case, and runs of space, do not count. */
function key(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

const BY_KEY: ReadonlyMap<string, StackTechnology> = new Map(
  STACK_CATALOG.flatMap((technology) =>
    [technology.name, ...(technology.aliases ?? [])].map(
      (name) => [key(name), technology] as const,
    ),
  ),
);

/** The catalog's entry a name or one of its spellings names, if any. */
export function stackTechnology(name: string): StackTechnology | undefined {
  return BY_KEY.get(key(name));
}

/**
 * A name as it is stored: the catalog's own spelling when it has the
 * technology, and otherwise as typed, trimmed and with its spaces collapsed.
 */
export function canonicalStackName(name: string): string {
  return stackTechnology(name)?.name ?? name.trim().replace(/\s+/g, " ");
}

/** Whether two names are the same technology. */
export function sameStackName(a: string, b: string): boolean {
  return key(canonicalStackName(a)) === key(canonicalStackName(b));
}

/**
 * A stack as it is stored: every name canonical, none empty, and each
 * technology once, in the order first given.
 */
export function normalizeStack(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const name of names) {
    const canonical = canonicalStackName(name);
    const compared = key(canonical);
    if (compared === "" || seen.has(compared)) continue;
    seen.add(compared);
    stack.push(canonical);
  }
  return stack;
}
