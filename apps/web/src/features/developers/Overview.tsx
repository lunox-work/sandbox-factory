/**
 * The portal's front page: whether the workspace has GitHub and Jira
 * connected (connecting stays a browser step on the settings page, which
 * these rows link to), and the shortest way in from each surface: the API,
 * MCP and the command-line clients.
 */

import type { MembershipDto } from "@sandbox-factory/shared";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

import { LoadingLine } from "@/components/Message";
import { SectionHeader } from "@/components/Page";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/format";

import { JiraIcon, ProviderIcon } from "../../ProviderIcon";
import {
  isPlainLeftClick,
  pathForScreen,
  type ConnectionTab,
  type DeveloperSection,
} from "../../routes";
import { useGithub } from "../../useGithub";
import { useJira } from "../../useJira";
import { CodeBlock } from "./CodeBlock";
import {
  appOrigin,
  claudeMcpAdd,
  CLI_LOGINS,
  curlMe,
  PLUGIN_INSTALLS,
} from "./snippets";

export function Overview({
  organization,
  onOpenConnection,
  onOpenSection,
}: {
  organization: MembershipDto;
  onOpenConnection: (tab: ConnectionTab) => void;
  onOpenSection: (section: DeveloperSection) => void;
}) {
  const origin = appOrigin();
  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="developers-connections">
        <SectionHeader
          id="developers-connections"
          title="Connections"
          description="Connecting is a browser step: the API and MCP can read what is connected, not connect it."
        />
        <ul className="mt-4 divide-y rounded-lg border">
          <GithubRow
            organization={organization}
            onOpen={() => onOpenConnection("github")}
          />
          <JiraRow
            organization={organization}
            onOpen={() => onOpenConnection("jira")}
          />
        </ul>
      </section>

      <section aria-labelledby="developers-quickstart" className="min-w-0">
        <SectionHeader
          id="developers-quickstart"
          title="Quickstart"
          description="A token belongs to one workspace and acts as the owner or admin who made it."
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenSection("tokens")}
            >
              Make a token
              <ArrowRight />
            </Button>
          }
        />
        <div className="mt-4 grid min-w-0 gap-6">
          <Quickstart
            title="API"
            text="Call any route in the API reference with a workspace token."
          >
            <CodeBlock
              label="Terminal"
              code={curlMe(origin)}
              copyLabel="Copy API example"
            />
          </Quickstart>
          <Quickstart
            title="MCP"
            text="Install a plugin, or add the server to Claude Code; it signs in over OAuth for one workspace."
          >
            <CodeBlock
              label="Terminal"
              code={[...PLUGIN_INSTALLS, claudeMcpAdd(origin)].join("\n")}
              copyLabel="Copy MCP commands"
            />
          </Quickstart>
          <Quickstart
            title="Command line"
            text="Each client signs in through this browser and mints its own token."
          >
            <CodeBlock
              label="Terminal"
              code={CLI_LOGINS.join("\n")}
              copyLabel="Copy CLI commands"
            />
          </Quickstart>
        </div>
      </section>
    </div>
  );
}

function Quickstart({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-2">
      <div>
        <h3 className="text-subheading">{title}</h3>
        <p className="text-muted-foreground text-sm">{text}</p>
      </div>
      {children}
    </div>
  );
}

function GithubRow({
  organization,
  onOpen,
}: {
  organization: MembershipDto;
  onOpen: () => void;
}) {
  const github = useGithub(organization.id);
  const healthy = github.connections.filter((entry) => entry.healthy);
  const accounts = healthy.map((entry) => entry.accountLogin);
  return (
    <ConnectionRow
      icon={<ProviderIcon provider="github" />}
      name="GitHub"
      loading={github.loading}
      error={github.error}
      status={
        github.unconfigured
          ? { tone: "off", text: "Not offered on this server" }
          : healthy.length > 0
            ? {
                tone: "on",
                text: `Connected · ${accounts.join(", ")}`,
              }
            : github.connections.length > 0
              ? { tone: "warn", text: "Needs attention" }
              : { tone: "off", text: "Not connected" }
      }
      action={
        github.unconfigured
          ? undefined
          : healthy.length > 0
            ? "Manage"
            : "Connect"
      }
      href={pathForScreen(
        "org-settings",
        organization.slug,
        undefined,
        "github",
      )}
      onOpen={onOpen}
    />
  );
}

function JiraRow({
  organization,
  onOpen,
}: {
  organization: MembershipDto;
  onOpen: () => void;
}) {
  const jira = useJira(organization.id);
  const healthy = jira.connections.filter((entry) => entry.healthy);
  return (
    <ConnectionRow
      icon={<JiraIcon />}
      name="Jira"
      loading={jira.loading}
      error={jira.error}
      status={
        jira.unconfigured
          ? { tone: "off", text: "Not offered on this server" }
          : healthy.length > 0
            ? {
                tone: "on",
                text: `Connected · ${plural(healthy.length, "site")}`,
              }
            : jira.connections.length > 0
              ? { tone: "warn", text: "Needs attention" }
              : { tone: "off", text: "Not connected" }
      }
      action={
        jira.unconfigured
          ? undefined
          : healthy.length > 0
            ? "Manage"
            : "Connect"
      }
      href={pathForScreen("org-settings", organization.slug, undefined, "jira")}
      onOpen={onOpen}
    />
  );
}

function ConnectionRow({
  icon,
  name,
  loading,
  error,
  status,
  action,
  href,
  onOpen,
}: {
  icon: ReactNode;
  name: string;
  loading: boolean;
  error: string | null;
  status: { tone: "on" | "warn" | "off"; text: string };
  action: string | undefined;
  href: string;
  onOpen: () => void;
}) {
  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-3">
      <span className="grid size-5 shrink-0 place-items-center [&_svg]:size-5">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{name}</p>
        {loading ? (
          <LoadingLine className="text-xs" />
        ) : error !== null ? (
          <p className="text-destructive text-xs">{error}</p>
        ) : (
          <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
            <span
              aria-hidden="true"
              className={
                status.tone === "on"
                  ? "size-1.5 shrink-0 rounded-full bg-emerald-500"
                  : status.tone === "warn"
                    ? "size-1.5 shrink-0 rounded-full bg-amber-500"
                    : "bg-muted-foreground/40 size-1.5 shrink-0 rounded-full"
              }
            />
            <span className="truncate">{status.text}</span>
          </p>
        )}
      </div>
      {action !== undefined && !loading && (
        <Button asChild variant="outline" size="sm">
          <a
            href={href}
            aria-label={`${action} ${name}`}
            onClick={(event) => {
              if (isPlainLeftClick(event)) {
                event.preventDefault();
                onOpen();
              }
            }}
          >
            {action}
          </a>
        </Button>
      )}
    </li>
  );
}
