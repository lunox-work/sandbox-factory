#!/usr/bin/env node
/**
 * Writes the tech stack logos into `src/assets/stack/`, one file per
 * technology, from Iconify's copies of the icon sets below.
 *
 *     node apps/web/scripts/stack-icons.mjs
 *
 * **vscode-icons first**, the file icons Visual Studio Code shows beside a
 * file name, so the picker reads like an editor's file tree. Where that set
 * has a `light-` variant of an icon, as it does for a mark drawn in white for
 * the editor's dark theme, both are written: `<slug>.light.svg` for the light
 * theme and `<slug>.dark.svg` for the dark, the same switch the editor makes.
 *
 * **Then another set's colour logo**, for a technology vscode-icons has no
 * file icon for. Each is put on vscode-icons' grid: square, with the same
 * margin round the mark, so it sits at the same size as its neighbours.
 * A one-colour mark is drawn in its brand colour from simple-icons, and one
 * whose colour is near black is drawn white for the dark theme.
 *
 * Files are named by `stackIconSlug` in `src/components/StackIcon.tsx`, and
 * `test/stack-icon.test.tsx` fails for a catalog entry with no file here.
 * Run it again after changing the table; it rewrites the folder.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";

const OUT = new URL("../src/assets/stack/", import.meta.url);

/** vscode-icons' file icon; its `light-` variant is found by name. */
const file = (name) => `vscode-icons:file-type-${name}`;

/**
 * A one-colour mark drawn in `light`, and in `dark` on the dark theme. Only
 * a near-black brand colour needs the second.
 */
const ink = (id, light, dark = light) => ({ id, light, dark });

/** By slug. Grouped as the catalog is, in `packages/core/src/stack.ts`. */
const ICONS = {
  // Languages.
  typescript: file("typescript"),
  javascript: file("js"),
  python: file("python"),
  java: file("java"),
  kotlin: file("kotlin"),
  csharp: file("csharp"),
  go: file("go"),
  rust: file("rust"),
  ruby: file("ruby"),
  php: file("php"),
  swift: file("swift"),
  dart: file("dartlang"),
  scala: file("scala"),
  elixir: file("elixir"),
  c: file("c"),
  cplusplus: file("cpp"),

  // Frameworks and runtimes.
  nodedotjs: file("node"),
  react: file("reactjs"),
  nextdotjs: file("next"),
  vue: file("vue"),
  nuxt: file("nuxt"),
  angular: file("angular"),
  svelte: file("svelte"),
  astro: file("astro"),
  remix: ink("simple-icons:remix", "#000000", "#ffffff"),
  expo: file("expo"),
  electron: file("electron"),
  flutter: file("flutter"),
  tailwindcss: file("tailwind"),
  express: ink("simple-icons:express", "#0a0a0a", "#ffffff"),
  fastify: ink("simple-icons:fastify", "#000000", "#ffffff"),
  nestjs: file("nestjs"),
  hono: "logos:hono",
  koa: ink("simple-icons:koa", "#33333d", "#ffffff"),
  graphql: file("graphql"),
  trpc: "devicon:trpc",
  django: file("django"),
  flask: ink("simple-icons:flask", "#3babc3"),
  fastapi: "logos:fastapi-icon",
  celery: ink("simple-icons:celery", "#37814a"),
  springboot: "logos:spring-icon",
  quarkus: "logos:quarkus-icon",
  dotnet: "logos:dotnet",
  rubyonrails: file("rails"),
  laravel: "logos:laravel",
  symfony: file("symfony"),
  // logos' drawing is the full mascot, 50 KB for a 16px icon.
  gin: ink("simple-icons:gin", "#008ecf"),
  actixweb: ink("simple-icons:actix", "#000000", "#ffffff"),

  // Databases, caches and queues.
  postgresql: file("pgsql"),
  mysql: file("mysql"),
  mariadb: file("mariadb"),
  microsoftsqlserver: "devicon:microsoftsqlserver",
  sqlite: file("sqlite"),
  mongodb: file("mongo"),
  redis: "logos:redis",
  elasticsearch: file("elastic"),
  amazondynamodb: "logos:aws-dynamodb",
  apachekafka: ink("simple-icons:apachekafka", "#231f20", "#ffffff"),
  rabbitmq: "logos:rabbitmq-icon",

  // Cloud and third-party services.
  aws: file("aws"),
  amazoncognito: "logos:aws-cognito",
  amazons3: "logos:aws-s3",
  awslambda: "logos:aws-lambda",
  amazonsqs: "logos:aws-sqs",
  amazonsns: "logos:aws-sns",
  amazonrds: "logos:aws-rds",
  amazonecs: "logos:aws-ecs",
  googlecloud: "logos:google-cloud",
  azure: file("azure"),
  firebase: file("firebase"),
  supabase: "logos:supabase-icon",
  stripe: ink("simple-icons:stripe", "#635bff"),
  auth0: ink("simple-icons:auth0", "#eb5424"),
  clerk: "logos:clerk-icon",
  twilio: "logos:twilio-icon",
  sendgrid: "logos:sendgrid-icon",
  slack: "logos:slack-icon",
  // simple-icons dropped OpenAI's mark; this one is drawn without a fill.
  openai: ink("logos:openai-icon", "#000000", "#ffffff"),
  anthropic: ink("simple-icons:anthropic", "#191919", "#ffffff"),
  sentry: file("sentry"),
  vercel: file("vercel"),
  netlify: file("netlify"),
  flydotio: file("flyio"),

  // Tools: infrastructure, build, data access and tests.
  docker: file("docker"),
  kubernetes: "logos:kubernetes",
  helm: file("helm"),
  terraform: file("terraform"),
  serverlessframework: file("serverless"),
  githubactions: "logos:github-actions",
  gitlabci: file("gitlab"),
  turborepo: file("turbo"),
  nx: file("nx"),
  vite: file("vite"),
  webpack: file("webpack"),
  maven: file("maven"),
  gradle: file("gradle"),
  prisma: file("prisma"),
  drizzle: file("drizzle-orm"),
  typeorm: "logos:typeorm",
  sequelize: file("sequelize"),
  sqlalchemy: ink("simple-icons:sqlalchemy", "#d71f00"),
  hibernate: "logos:hibernate",
  entityframework: "devicon:entityframeworkcore",
  jest: file("jest"),
  vitest: file("vitest"),
  playwright: file("playwright"),
  cypress: file("cypress"),
  pytest: file("pytest"),
  junit: "devicon:junit",
  storybook: file("storybook"),
};

/** vscode-icons' grid: a 32 square, the mark inside a 2 margin. */
const GRID = 32;
const MARGIN = 2;

const idOf = (source) => (typeof source === "string" ? source : source.id);

/** Every icon named, and each vscode-icons icon's light variant, by set. */
function wanted() {
  const sets = new Map();
  const want = (id) => {
    const [prefix, name] = id.split(":");
    if (!sets.has(prefix)) sets.set(prefix, new Set());
    sets.get(prefix).add(name);
  };
  for (const source of Object.values(ICONS)) {
    const id = idOf(source);
    want(id);
    if (id.startsWith("vscode-icons:file-type-")) {
      want(id.replace("file-type-", "file-type-light-"));
    }
  }
  return sets;
}

/** Iconify's JSON for some icons of one set. Unknown names are left out. */
async function fetchSet(prefix, names) {
  const url = new URL(`https://api.iconify.design/${prefix}.json`);
  url.searchParams.set("icons", [...names].join(","));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

/** An icon's body and box, through an alias if it is one. */
function lookup(sets, id) {
  const [prefix, name] = id.split(":");
  const set = sets.get(prefix);
  const alias = set?.aliases?.[name];
  const icon = set?.icons?.[alias?.parent ?? name];
  if (icon === undefined) return undefined;
  if (icon.rotate || icon.hFlip || icon.vFlip || alias?.rotate) {
    throw new Error(`${id} is transformed, which is not handled`);
  }
  return {
    body: icon.body,
    left: icon.left ?? set.left ?? 0,
    top: icon.top ?? set.top ?? 0,
    width: icon.width ?? set.width ?? 16,
    height: icon.height ?? set.height ?? 16,
  };
}

/** A standalone SVG: vscode-icons' as drawn, another set's put on its grid. */
function svgDocument(sets, id, fill) {
  const icon = lookup(sets, id);
  if (icon === undefined) throw new Error(`no icon ${id}`);
  let body = icon.body;
  if (fill !== undefined) {
    body = `<g fill="${fill}">${body.replaceAll("currentColor", fill)}</g>`;
  }
  if (id.startsWith("vscode-icons:")) {
    const box = `${icon.left} ${icon.top} ${icon.width} ${icon.height}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${body}</svg>\n`;
  }
  // Scaled so the longer side spans the grid inside the margin, and centred.
  const scale = (GRID - 2 * MARGIN) / Math.max(icon.width, icon.height);
  const x = (GRID - icon.width * scale) / 2 - icon.left * scale;
  const y = (GRID - icon.height * scale) / 2 - icon.top * scale;
  const round = (n) => Number(n.toFixed(4));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}"><g transform="translate(${round(x)} ${round(y)}) scale(${round(scale)})">${body}</g></svg>\n`;
}

const sets = new Map();
for (const [prefix, names] of wanted()) {
  sets.set(prefix, await fetchSet(prefix, names));
}

await mkdir(OUT, { recursive: true });
for (const name of await readdir(OUT)) {
  if (name.endsWith(".svg")) await rm(new URL(name, OUT));
}

let written = 0;
for (const [slug, source] of Object.entries(ICONS)) {
  const id = idOf(source);
  const lightId = id.replace("file-type-", "file-type-light-");
  const themed =
    typeof source === "string"
      ? id.startsWith("vscode-icons:file-type-") &&
        lookup(sets, lightId) !== undefined
        ? { light: svgDocument(sets, lightId), dark: svgDocument(sets, id) }
        : undefined
      : source.light !== source.dark
        ? {
            light: svgDocument(sets, id, source.light),
            dark: svgDocument(sets, id, source.dark),
          }
        : undefined;
  if (themed === undefined) {
    const fill = typeof source === "string" ? undefined : source.light;
    await writeFile(new URL(`${slug}.svg`, OUT), svgDocument(sets, id, fill));
    written += 1;
  } else {
    await writeFile(new URL(`${slug}.light.svg`, OUT), themed.light);
    await writeFile(new URL(`${slug}.dark.svg`, OUT), themed.dark);
    written += 2;
  }
}
console.log(`${written} files for ${Object.keys(ICONS).length} icons`);
