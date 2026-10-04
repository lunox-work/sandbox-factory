import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  MembershipClient,
  JiraManagementClient,
  GithubManagementClient,
  PricingClient,
  BountyClient,
  BountyRunClient,
  GithubAnalysisClient,
  SandboxClient,
} from "@sandbox-factory/client";

const UserContext = createContext<string | null>(null);
export const queryKeys = {
  user: (userId: string) => ["user", userId] as const,
  me: (userId: string, resource: string) =>
    ["user", userId, "me", resource] as const,
  owner: (userId: string, owner: string) =>
    ["user", userId, "org", owner] as const,
  resource: (
    userId: string,
    owner: string,
    resource: string,
    ...params: unknown[]
  ) => ["user", userId, "org", owner, resource, ...params] as const,
};
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { retry: false },
    },
  });
}
export function ServerDataProvider({
  userId,
  children,
  client: supplied,
}: {
  userId: string;
  children: ReactNode;
  client?: QueryClient;
}) {
  const client = useMemo(
    () => supplied ?? createQueryClient(),
    [supplied, userId],
  );
  useEffect(
    () => () => {
      void client.cancelQueries();
      client.clear();
    },
    [client],
  );
  return (
    <UserContext.Provider value={userId}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </UserContext.Provider>
  );
}
export function useUserId() {
  const userId = useContext(UserContext);
  if (userId === null)
    throw new Error("Server data requires an authenticated user scope.");
  return userId;
}
// Resolve fetch at call time so the platform and test boundary both stay injectable.
const options = {
  baseUrl: "",
  fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch,
};
export const clients = {
  memberships: new MembershipClient(options),
  jira: new JiraManagementClient(options),
  github: new GithubManagementClient(options),
  pricing: new PricingClient(options),
  bounties: new BountyClient(options),
  runs: new BountyRunClient(options),
  analysis: new GithubAnalysisClient(options),
  sandbox: new SandboxClient(options),
};
export function useInvitationsQuery() {
  const userId = useUserId();
  return useQuery({
    queryKey: queryKeys.me(userId, "invitations"),
    queryFn: ({ signal }) => clients.memberships.invitations(signal),
  });
}
export function useOwnerQuery<T>(
  owner: string | undefined,
  resource: string,
  read: (owner: string, signal: AbortSignal) => Promise<T>,
) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.resource(userId, owner ?? "", resource);
  const query = useQuery({
    queryKey,
    enabled: owner !== undefined,
    queryFn: ({ signal }) => {
      if (owner === undefined) throw new Error("Missing owner.");
      return read(owner, signal);
    },
  });
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.resource(userId, owner ?? "", resource),
    });
  }, [queryClient, userId, owner, resource]);
  const setData = useCallback(
    (update: (current: T | undefined) => T) => {
      queryClient.setQueryData<T>(
        queryKeys.resource(userId, owner ?? "", resource),
        update,
      );
    },
    [queryClient, userId, owner, resource],
  );
  return { ...query, refresh, setData };
}
