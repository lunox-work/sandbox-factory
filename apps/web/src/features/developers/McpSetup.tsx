/**
 * MCP: the three server URLs and what each exposes, and how to add them to
 * Claude Code, Cursor and Codex. Every client signs in over OAuth on first
 * use and is bound to the one workspace chosen on the consent page; it then
 * shows under Connected apps.
 */

import type { ReactNode } from "react";

import { SectionHeader } from "@/components/Page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { CodeBlock, CopyValue } from "./CodeBlock";
import { Chips } from "./parts";
import {
  appOrigin,
  claudeMcpAdd,
  codexConfig,
  cursorConfig,
  MCP_SERVERS,
  PLUGIN_INSTALLS,
} from "./snippets";

export function McpSetup() {
  const origin = appOrigin();
  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="developers-mcp" className="flex flex-col gap-4">
        <SectionHeader
          id="developers-mcp"
          title="MCP servers"
          description="Streamable HTTP, read tools only for now. Each tool calls one public API route as you, so the same scopes and roles apply."
        />
        <ul aria-label="MCP servers" className="divide-y rounded-lg border">
          {MCP_SERVERS.map((server) => (
            <li
              key={server.path}
              aria-label={server.path}
              className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] md:gap-6"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{server.title}</p>
                <p className="text-muted-foreground text-xs">
                  {server.description}
                </p>
                <Chips
                  label={`${server.title} tools`}
                  items={server.tools}
                  className="mt-2"
                />
              </div>
              <CopyValue
                className="self-start"
                value={`${origin}${server.path}`}
                label={`Copy ${server.path} URL`}
              />
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="developers-mcp-install"
        className="flex min-w-0 flex-col gap-4"
      >
        <SectionHeader
          id="developers-mcp-install"
          title="Install"
          description="Add the server to your client, then sign in when it asks: pick the workspace on the consent page."
        />
        <Tabs defaultValue="claude" className="min-w-0 gap-4">
          <TabsList variant="line">
            <TabsTrigger value="claude">Claude Code</TabsTrigger>
            <TabsTrigger value="cursor">Cursor</TabsTrigger>
            <TabsTrigger value="codex">Codex</TabsTrigger>
          </TabsList>
          <TabsContent value="claude" className="flex min-w-0 flex-col gap-4">
            <Step text="With a plugin, which brings its skills and its own toolset:">
              <CodeBlock
                label="Terminal"
                code={PLUGIN_INSTALLS.join("\n")}
                copyLabel="Copy plugin install"
              />
            </Step>
            <Step text="Or the server on its own:">
              <CodeBlock
                label="Terminal"
                code={claudeMcpAdd(origin)}
                copyLabel="Copy claude mcp add"
              />
            </Step>
          </TabsContent>
          <TabsContent value="cursor" className="flex min-w-0 flex-col gap-4">
            <Step text="In your project’s .cursor/mcp.json, or ~/.cursor/mcp.json for every project:">
              <CodeBlock
                label="mcp.json"
                code={cursorConfig(origin)}
                copyLabel="Copy Cursor config"
              />
            </Step>
          </TabsContent>
          <TabsContent value="codex" className="flex min-w-0 flex-col gap-4">
            <Step text="In ~/.codex/config.toml, then sign in with codex mcp login lunox:">
              <CodeBlock
                label="config.toml"
                code={codexConfig(origin)}
                copyLabel="Copy Codex config"
              />
            </Step>
          </TabsContent>
        </Tabs>
        <p className="text-muted-foreground text-xs">
          For one toolset, swap the URL for{" "}
          <code className="font-mono">/mcp/duediligence</code> or{" "}
          <code className="font-mono">/mcp/carveout</code>.
        </p>
      </section>
    </div>
  );
}

function Step({ text, children }: { text: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-sm">{text}</p>
      {children}
    </div>
  );
}
