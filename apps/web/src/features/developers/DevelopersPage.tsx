/**
 * The developer portal, `/o/:slug/developers[/:section]`: what a workspace
 * needs to reach the platform from code, CI or an agent. API tokens,
 * connected OAuth apps, MCP setup, the API reference and usage, under one
 * heading with a sub-navigation down its side (along its top on a phone).
 *
 * Owners and admins only, as the API decides: tokens and grants are theirs
 * to manage, and a token acts as an owner or admin. A member sees a line
 * saying so rather than pages of controls the server would refuse. Hiding
 * them is courtesy; the API checks the role on every call.
 */

import type { MembershipDto } from "@sandbox-factory/shared";
import { lazy, Suspense } from "react";
import { rankAtLeast } from "sandbox-factory";

import { LoadingLine } from "@/components/Message";
import { Page, PageHeader } from "@/components/Page";
import { cn } from "@/lib/utils";

import {
  developersPath,
  isPlainLeftClick,
  type ConnectionTab,
  type DeveloperSection,
} from "../../routes";
import { ApiTokens } from "./ApiTokens";
import { ConnectedApps } from "./ConnectedApps";
import { McpSetup } from "./McpSetup";
import { Overview } from "./Overview";
import { Usage } from "./Usage";

/*
  Its own chunk: the reader is small, but the document it lays out is near
  a megabyte, and neither is wanted until someone opens the reference.
*/
const ApiReference = lazy(() =>
  import("./ApiReference").then(({ ApiReference }) => ({
    default: ApiReference,
  })),
);

const SECTIONS: ReadonlyArray<{ section: DeveloperSection; label: string }> = [
  { section: "overview", label: "Overview" },
  { section: "tokens", label: "API tokens" },
  { section: "apps", label: "Connected apps" },
  { section: "mcp", label: "MCP" },
  { section: "reference", label: "API reference" },
  { section: "usage", label: "Usage" },
];

export function DevelopersPage({
  organization,
  section,
  onNavigate,
  onOpenConnection,
}: {
  organization: MembershipDto;
  section: DeveloperSection;
  /** Goes to a URL as a new page; the shell's `visit`. */
  onNavigate: (url: string) => void;
  /** Opens the workspace's settings on a Connections tab. */
  onOpenConnection: (tab: ConnectionTab) => void;
}) {
  const admin = rankAtLeast(organization.role, "admin");
  const open = (next: DeveloperSection) =>
    onNavigate(developersPath(organization.slug, next));

  return (
    <Page>
      <PageHeader
        title="Developers"
        description={`Reach ${organization.name} from code, CI and agents: API tokens, connected apps, MCP and the API reference.`}
      />
      {!admin ? (
        <p
          role="note"
          className="text-muted-foreground mt-8 max-w-prose rounded-lg border px-4 py-3 text-sm"
        >
          {`The developer portal is for owners and admins of ${organization.name}. Ask one of them for an API token or to connect an app.`}
        </p>
      ) : (
        <div className="mt-8 grid gap-6 md:grid-cols-[10rem_minmax(0,1fr)] md:gap-10">
          <DevelopersNav
            slug={organization.slug}
            current={section}
            onOpen={open}
          />
          <div className="min-w-0">
            {section === "overview" ? (
              <Overview
                organization={organization}
                onOpenConnection={onOpenConnection}
                onOpenSection={open}
              />
            ) : section === "tokens" ? (
              <ApiTokens organizationId={organization.id} />
            ) : section === "apps" ? (
              <ConnectedApps
                organizationId={organization.id}
                onOpenMcp={() => open("mcp")}
              />
            ) : section === "mcp" ? (
              <McpSetup />
            ) : section === "reference" ? (
              <Suspense fallback={<LoadingLine />}>
                <ApiReference />
              </Suspense>
            ) : (
              <Usage organizationId={organization.id} />
            )}
          </div>
        </div>
      )}
    </Page>
  );
}

/**
 * The portal's own navigation. A column of links beside the content from
 * `md` up; a row that scrolls sideways within the column on a phone, so it
 * never widens the page.
 */
function DevelopersNav({
  slug,
  current,
  onOpen,
}: {
  slug: string;
  current: DeveloperSection;
  onOpen: (section: DeveloperSection) => void;
}) {
  return (
    <nav aria-label="Developers" className="min-w-0">
      <ul className="-mx-2.5 flex gap-1 overflow-x-auto pb-1 [scrollbar-width:none] md:sticky md:top-6 md:mr-0 md:flex-col md:overflow-visible [&::-webkit-scrollbar]:hidden">
        {SECTIONS.map(({ section, label }) => (
          <li key={section} className="shrink-0">
            <a
              href={developersPath(slug, section)}
              aria-current={section === current ? "page" : undefined}
              className={cn(
                "flex h-8 items-center rounded-md px-2.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                section === current
                  ? "bg-accent text-foreground font-medium"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              onClick={(event) => {
                if (isPlainLeftClick(event)) {
                  event.preventDefault();
                  onOpen(section);
                }
              }}
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
