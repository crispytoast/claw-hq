import { useCallback, useEffect, useRef, useState } from "react";
import type { GatewayClient, ConnectionStatus } from "../../gateway.js";

interface State<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Pattern: page mounts → wait for gateway ready → call one RPC → render.
 * Refreshable. Handles unmount safely.
 */
export function usePageRpc<T>(
  client: GatewayClient | null,
  status: ConnectionStatus,
  method: string,
  params: unknown = {},
): State<T> & { refresh: () => void } {
  const [state, setState] = useState<State<T>>({ data: null, loading: true, error: null });
  const seq = useRef(0);

  const run = useCallback(async () => {
    if (!client || status.kind !== "ready") return;
    const mySeq = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await client.call<T>(method, params);
      if (seq.current === mySeq) setState({ data, loading: false, error: null });
    } catch (err) {
      if (seq.current === mySeq) {
        setState({ data: null, loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }, [client, status.kind, method, JSON.stringify(params)]);

  useEffect(() => { void run(); }, [run]);

  return { ...state, refresh: () => void run() };
}
