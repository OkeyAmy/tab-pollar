import type { PaymentIntent } from "./index";
import { TESTNET_USDC_ISSUER } from "./index";

/**
 * A valid USDC/Stellar intent. Tests override only the field they assert on,
 * so a change to the default never silently changes unrelated expectations.
 */
export function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    chargeId: "chg_0123456789abcdef",
    chain: "STELLAR",
    destination: "GC4Q5TWWXI7IHN6DYCBEKCOWJWCKY4JE2NLKLU5SE3YL44IUUFPKUOPC",
    amount: "2.50",
    asset: "USDC",
    assetIssuer: TESTNET_USDC_ISSUER,
    memo: "TAB:0123456789abcdef",
    merchantName: "Exa",
    description: "Exa starter",
    ...overrides,
  };
}
