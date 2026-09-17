# Security Policy

## Supported versions

| Version        | Supported |
| -------------- | --------- |
| Latest release | Yes       |
| Older releases | No        |

## Verifying what we run

You do not have to take our word for which code is serving you. Every
deployment signs the image it runs and every file it publishes, in a public
transparency log, and one command checks the live site against those
signatures:

```bash
./scripts/verify-production.sh
```

It confirms that the running API image and every file the CDN served were built
by `.github/workflows/cd.yml`, from `main`, at the commit the site reports — and
it fails if any of that does not hold. `docs/versioning.md` explains the chain,
how to check it by hand, and, just as importantly, what it does **not** prove.

Reading the source tells you what we store. The signatures tell you that the
source is what is running.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report privately through
[GitHub Security Advisories](https://github.com/lunox-work/sandbox-factory/security/advisories/new),
or by email to security@lunox.work.

Please include:

- The type of issue and where the affected source is
- Steps to reproduce, and a proof of concept if you have one
- What an attacker could do with it

## What to expect

- **Acknowledgement** within 3 business days.
- **Assessment** within 10 business days, with our view of severity and a fix
  timeline.
- **Disclosure** coordinated with you once a fix is released. We are happy to
  credit you in the advisory unless you would rather stay anonymous.

Please give us a reasonable window to ship a fix before disclosing publicly.
