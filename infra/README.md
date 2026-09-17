# Infrastructure

Terraform for `sandbox-factory` on AWS, serving <https://platform.lunox.work>.

Everything here is declarative except the two things that should not be: secret
values, which are pushed out of band, and `terraform apply`, which stays a
deliberate local action so no merge can replace a database.

## Shape

```
              platform.lunox.work
                       │
                  CloudFront
                 ╱           ╲
        default              /api/*
           │                    │
     S3 (private,     api.platform.lunox.work
      OAC-read)        (origin_dns keeps this
                       on the task's public IP)
                                │
                          Fargate ARM64
                            0.25 vCPU
                                │
                        Neon Postgres 17
                          (outside AWS)
```

One hostname, two origins. The SPA and the API share an origin because
`apps/web/nginx.conf` and the Vite dev proxy already do — so the session cookie
stays host-only and no request needs a CORS preflight.

**There is no load balancer.** At the traffic this is sized for, an ALB costs
$16.43/month to give one task a stable name. Instead an EventBridge rule fires
on every ECS task state change and a small function
([`lambda/origin_dns.py`](lambda/origin_dns.py)) writes the running task's
_public_ IP into `api.platform.lunox.work`, which CloudFront uses as its origin.

ECS Service Discovery was tried first and cannot do this: with `awsvpc`
networking it registers the task's _private_ IP, which CloudFront cannot reach.
What you still give up is the ALB's TLS termination — see the trade-offs at the
bottom of this file.

## Cost

About **$15/month**, from live Pricing API rates:

|                                             | Monthly |
| ------------------------------------------- | ------- |
| Fargate ARM 0.25 vCPU / 0.5 GB              | $7.21   |
| Public IPv4 address                         | $3.65   |
| Neon Postgres (free tier)                   | $0.00   |
| CloudFront, S3, ECR, Secrets, Route53, logs | ~$4.40  |
| Route53 health check + 4 alarms             | ~$0.90  |

Three things are deliberately absent, and together they are most of the saving:

- **No NAT Gateway** — $32.85/month avoided. See the comment at the top of `vpc.tf`.
- **No ALB** — $16.43/month avoided. Service Discovery does the addressing.
- **No RDS** — $13.98/month avoided. Neon's free tier covers this workload.

The path back up is short: putting an ALB in front is one file, and moving to
RDS is a connection string. Do both when traffic justifies them.

## Monitoring

Four alarms, all reporting to the `sandbox-factory-alarms` SNS topic, which
mails `var.alarm_email`. A new address has to click the confirmation link AWS
sends before anything reaches it — until then the subscription reads
`PendingConfirmation` and alarms notify nobody.

| Alarm              | Fires when                                           |
| ------------------ | ---------------------------------------------------- |
| `platform-down`    | `/health` stops answering, probed from outside AWS   |
| `origin-errors`    | CloudFront sees >5% 5xx from the API origin          |
| `monthly-spend`    | Estimated charges pass `var.billing_alarm_threshold` |
| `no-running-tasks` | No task is running — **dormant**, see below          |

`platform-down` is the one that answers "is the site up?". It is a Route53
health check ($0.50/month) hitting `https://platform.lunox.work/health` every
30 seconds from checkers on several continents, so it catches a failure
anywhere between a user and the task — DNS, CloudFront, the certificate, the
origin record — and not only a dead container. Two things make that endpoint
safe to probe: `routes.ts` exempts `/health` from origin verification, and its
CloudFront behaviour uses the managed CachingDisabled policy, so the probe
reads live state rather than a cached `ok`.

It is also the one alarm with `treat_missing_data = "breaching"`. The others
guard metrics that legitimately go quiet; this one guards a probe that never
stops, so silence from it means the monitoring broke, which is worth waking up
for.

**`no-running-tasks` cannot currently fire.** Its metric comes from Container
Insights, which is off to save ~$2/month, so it reports no data and sits
permanently OK. It is kept because it names the cause where `platform-down`
only sees the symptom — switch on `containerInsights` in `ecs.tf` to arm it.
Do not read it being green as the platform being up.

## First deploy

Prerequisites: AWS CLI configured, Terraform >= 1.5, the three OAuth apps
registered, and a Neon project.

### 0. Neon

Create a project at <https://console.neon.tech> — the free tier is enough — and
copy the **pooled** connection string (its host contains `-pooler`). It must
carry `?sslmode=require`; Neon refuses an unencrypted connection, and the API
will fail to boot without it.

**Pick a region matching `var.region`.** The API reaches Postgres over the
public internet now rather than inside a VPC, so the distance between them is
real latency on every query. A Neon project in `us-east-2` against tasks in
`us-east-1` adds roughly 10-15 ms per round trip — tolerable, but free to avoid
by choosing `us-east-1` in Neon, or by setting `var.region = "us-east-2"`.

### 1. State backend

```bash
./scripts/bootstrap-backend.sh
```

Creates a versioned, encrypted, private S3 bucket and writes `backend.hcl`.
Run once per account.

### 2. Provision

```bash
terraform init -backend-config=backend.hcl
terraform apply
```

Takes roughly 15 minutes; RDS and the CloudFront distribution are the slow
parts. Certificate validation is automatic because the Route53 zone is in the
same account.

On the first apply the ECS service starts with the `bootstrap` image tag, which
does not exist yet, so the task will fail to start. That is expected — the first
CD run pushes a real image and the service recovers.

### 3. Secrets

```bash
make secrets-template   # writes .env.production, mode 600
# paste the Neon connection string into DATABASE_URL
make secrets-check      # validates it the way the API does at boot
make secrets-push       # writes the eight values into Secrets Manager
```

`secrets-template` copies the six OAuth values from `.env.development` when they
are present and generates a fresh
`BETTER_AUTH_SECRET` — deliberately not the local one, since it signs session
tokens and production should not share a signing key with a dev machine.

`.env.production` matches the `.env.*` rule in `.gitignore`, so it cannot be
committed. Values go straight from your machine to Secrets Manager, never
through Terraform, so never into `terraform.tfstate`. Nothing reads the file at
runtime; it is the copy you keep, and `make secrets-push` is what publishes it.

`secrets-push` depends on `secrets-check`, so a malformed connection string or a
short signing secret is caught before it reaches AWS rather than as a
crash-looping task mid-deploy.

### 4. OAuth callbacks

Add the production redirect URI to each provider, **alongside** the existing
localhost one — do not replace it, or local development stops working:

```
https://platform.lunox.work/api/auth/callback/google
https://platform.lunox.work/api/auth/callback/github
https://platform.lunox.work/api/auth/callback/atlassian
```

An exact match is required, with no trailing slash. A mismatch fails at the
provider with `redirect_uri_mismatch`, not in your logs, which makes it slower
to diagnose than it should be. The path is fixed by the route in
`apps/api/src/routes.ts` and is not configurable.

**Google** and **Atlassian** accept several redirect URIs on one client, so the
same credentials serve both environments.

**GitHub OAuth Apps accept exactly one callback URL.** Two options: point the
existing app at production and use a second app for local development (its
client id and secret go in `.env`, not `.env.production`), or register a new app
for production and put its credentials in `.env.production`. Either way the two
environments end up with different GitHub client ids — which is why
`secrets-template` copies the local values as a starting point rather than a
final answer.

### 5. Wire up CD

```bash
terraform output github_deploy_role_arn
gh variable set AWS_DEPLOY_ROLE --body "<that arn>"
```

A repository _variable_, not a secret: a role ARN is not sensitive, and it is
useless without the OIDC trust policy that binds it to this repo's `main`.

### 6. Deploy

Push to `main`, or run the workflow by hand. The pipeline builds both apps,
migrates, rolls the service, publishes the SPA, and then asks the live site
whether it is serving the commit it just built.

## Day to day

| Task                 | Command                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| Rotate a secret      | edit `.env.production`, `make secrets-push`, then force a new deployment |
| Tail API logs        | `aws logs tail /ecs/sandbox-factory-api --follow`                        |
| What is deployed?    | `curl -s https://platform.lunox.work/version`                            |
| Roll back            | re-run the Deploy workflow against an older commit SHA                   |
| Scale up             | `api_desired_count = 2`, then apply                                      |
| Outgrow the database | `db_instance_class = "db.t4g.small"`, then apply                         |

## Things worth knowing before changing this

**The ECS service ignores `task_definition` and `desired_count` changes.** CD
updates both directly, and without `ignore_changes` the next `terraform apply`
would roll production back to whatever image the state remembers.

**Task architecture is ARM64.** CD builds `--platform linux/arm64` to match,
on a native `ubuntu-24.04-arm` runner — under emulation on an x86 runner the
same build took minutes and once hung a deploy for two hours.
A mismatch is not caught at build time — the task starts and dies with
`exec format error`.

**The origin is reachable from the internet, and the header is what guards it.**
With no load balancer, the task's port is open: CloudFront publishes no stable
IP range to pin a security group to. What separates a CDN request from a
stranger who resolved `api.platform.lunox.work` is the `X-Origin-Verify` header,
checked by middleware in `apps/api/src/routes.ts`. `/health` is exempt so ECS
and uptime probes still work. A request without the header gets a 404.

**CloudFront reaches the origin over HTTP.** Viewers always get HTTPS,
terminated at the edge. The CloudFront-to-task hop is plain HTTP inside AWS,
because terminating TLS on the task would mean shipping a certificate in the
container and changing `server.ts` to serve it. That was the trade for leaving
the application code alone — revisit it if the threat model changes.

**Postgres is Neon, outside AWS.** Two consequences. It suspends after about
five minutes idle, so the first request after a quiet period waits a few hundred
milliseconds while it wakes. And your user identity data lives with a third
party — the thing you are buying for $13.98/month if you move back to RDS.

**A deploy has a brief window with two tasks.** `deployment_minimum_healthy_percent = 100`
starts the new task before removing the old, so for a few seconds the discovery
record holds both IPs. CloudFront may reach either; both serve the same API.
The 15-second record TTL bounds how long a removed IP can still be cached.

**Moving back to an ALB.** Recreate `alb.tf`, add a `load_balancer` block to the
service, point the CloudFront origin at the ALB's DNS name with
`origin_protocol_policy = "https-only"`, and re-add the region-local ACM
certificate. `discovery.tf` — the function, its EventBridge rule and its role —
can then be deleted. The origin-verify middleware can stay: unset, it installs
nothing, and the ALB's listener rule does the same job.
