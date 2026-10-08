import { createContext, useContext } from "react";
import type { ProviderAccountTarget } from "./providerAccountTarget";

// Only the Providers route supplies this context. General settings retain their
// registered project scopes; a task checkout is only an account lookup target.
export const ProviderAccountContext = createContext<ProviderAccountTarget | null>(null);
export const useProviderAccountTarget = () => useContext(ProviderAccountContext);
