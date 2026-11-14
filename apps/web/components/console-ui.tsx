"use client";

import type { Charge } from "@tab/shared";
import { createContext, useContext } from "react";

export interface ConsoleUI {
  openTab: (agentId?: string | null) => void;
  openAgent: () => void;
  openReceipt: (charge: Charge) => void;
  openSigner: () => void;
}

export const ConsoleUIContext = createContext<ConsoleUI | null>(null);

export function useConsoleUI(): ConsoleUI {
  const value = useContext(ConsoleUIContext);
  if (!value) throw new Error("useConsoleUI must be used inside the console shell.");
  return value;
}
