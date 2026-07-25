import { createContext, useContext, type ReactNode } from "react";

const AgentUnavailableContext = createContext(false);

export function AgentAvailabilityProvider({
  unavailable,
  children,
}: {
  unavailable: boolean;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <AgentUnavailableContext.Provider value={unavailable}>
      {children}
    </AgentUnavailableContext.Provider>
  );
}

export function useAgentUnavailable(): boolean {
  return useContext(AgentUnavailableContext);
}
