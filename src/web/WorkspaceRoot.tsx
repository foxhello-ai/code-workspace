import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { useAppStore } from "./store";
import "./styles.css";
import "./workbench.css";

export default function WorkspaceRoot({ onLogout }: { onLogout(): void }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 500 } } }));
  useEffect(() => () => { useAppStore.getState().clear(); client.clear(); }, [client]);
  return <QueryClientProvider client={client}><App onLogout={onLogout}/></QueryClientProvider>;
}
