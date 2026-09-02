import { useEffect, useMemo, useState, type FormEvent } from "react";

import type { DesktopRuntimeStatus } from "@autostack/contracts";
import { AppShell } from "@autostack/ui";

import { createApiClient, type AutoStackApiClient } from "./api-client.js";
import { useFactory } from "./use-factory.js";
import { Workbench } from "./workbench/workbench.js";
import { RunSidebar } from "./workbench/run-sidebar.js";

const TOKEN_KEY = "autostack.local-api-token";

interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AppProps {
  readonly client?: AutoStackApiClient;
  readonly storage?: SessionStorage;
  readonly clientFactory?: (getToken: () => string | null) => AutoStackApiClient;
  readonly pollIntervalMs?: number;
  readonly executionAuthorityDisclosure?: boolean;
  readonly runtimeBridge?: DesktopRuntimeBridge;
}

export interface DesktopRuntimeBridge {
  runtimeStatus(): Promise<DesktopRuntimeStatus>;
  subscribeRuntimeStatus(listener: (status: DesktopRuntimeStatus) => void): () => void;
}

const defaultClientFactory = (getToken: () => string | null): AutoStackApiClient =>
  createApiClient({ baseUrl: "", getToken });

export function App({
  client,
  storage = window.sessionStorage,
  clientFactory = defaultClientFactory,
  pollIntervalMs = 5_000,
  executionAuthorityDisclosure = false,
  runtimeBridge
}: AppProps) {
  const [token, setToken] = useState<string | null>(() => storage.getItem(TOKEN_KEY));
  const [tokenInput, setTokenInput] = useState("");
  const [desktopRuntimeStatus, setDesktopRuntimeStatus] = useState<
    DesktopRuntimeStatus | undefined
  >(() => (runtimeBridge === undefined ? undefined : { status: "starting" }));
  const internalClient = useMemo(
    () => (token === null ? null : clientFactory(() => token)),
    [clientFactory, token]
  );
  const activeClient = client ?? internalClient;
  const factory = useFactory(activeClient, pollIntervalMs);

  useEffect(() => {
    if (runtimeBridge === undefined) {
      setDesktopRuntimeStatus(undefined);
      return;
    }
    let active = true;
    let receivedSubscription = false;
    const unsubscribe = runtimeBridge.subscribeRuntimeStatus((status) => {
      receivedSubscription = true;
      if (active) setDesktopRuntimeStatus(status);
    });
    void runtimeBridge
      .runtimeStatus()
      .then((status) => {
        if (active && !receivedSubscription) setDesktopRuntimeStatus(status);
      })
      .catch(() => {
        if (active && !receivedSubscription) {
          setDesktopRuntimeStatus({ status: "degraded", message: "Runtime status unavailable." });
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [runtimeBridge]);

  const connect = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (tokenInput.length === 0) return;
    storage.setItem(TOKEN_KEY, tokenInput);
    setToken(tokenInput);
    setTokenInput("");
  };

  if (activeClient === null) {
    return (
      <AppShell activeDestination="factory" sidebar={<RunSidebar runs={[]} />}>
        <section className="connection-panel" aria-labelledby="connection-title">
          <p className="eyebrow">Personal · local first</p>
          <h1 id="connection-title">Connect this AutoStack session</h1>
          <p>
            Enter the local control-plane token. It remains in this browser session and is cleared
            when the session closes.
          </p>
          <form onSubmit={connect}>
            <label htmlFor="local-token">Local API token</label>
            <input
              id="local-token"
              type="password"
              autoComplete="off"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              required
            />
            <button type="submit">Connect</button>
          </form>
        </section>
      </AppShell>
    );
  }

  return (
    <Workbench
      activeDestination="factory"
      factory={factory}
      client={activeClient}
      executionAuthorityDisclosure={executionAuthorityDisclosure}
      desktopRuntimeStatus={desktopRuntimeStatus}
    />
  );
}
