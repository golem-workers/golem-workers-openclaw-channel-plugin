import type {
  RelayApprovalRequest,
  RelayApprovalResult,
  RelayCapabilitySnapshot,
} from "../api.js";

export async function deliverApproval(
  request: RelayApprovalRequest,
  capabilities?: RelayCapabilitySnapshot
): Promise<RelayApprovalResult> {
  if (!capabilities?.optionalCapabilities.nativeApprovalDelivery) {
    throw new Error(
      `CAPABILITY_MISSING: native approval delivery is not available for ${request.accountId}`
    );
  }

  return {
    deliveredNatively: true,
    capabilityRequired: "nativeApprovalDelivery",
  };
}
