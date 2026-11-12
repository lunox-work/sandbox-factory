/**
 * Connecting GitHub or Jira is a browser step: a token cannot install an
 * App or consent at Atlassian. `GET .../github/connect` and
 * `.../jira/connect` redirect a browser there, and answer this to a client
 * that asks for JSON (`Accept: application/json`), for a person to open
 * while signed in to the web app.
 */

import { z } from "zod";

export const connectUrlResponseSchema = z.object({ url: z.url() });

export type ConnectUrlResponse = z.infer<typeof connectUrlResponseSchema>;
